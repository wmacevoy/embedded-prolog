// ============================================================
// estimator/main.js — Greenhouse VPD estimator node
//
// Runs under Node.js/Bun in Docker (demonstrating code that
// would run under QuickJS with BigDecimal in production).
//
// Listens on UDP for sensor readings, applies Prolog signal
// policy, computes VPD via the Magnus formula, and forwards
// estimates to the coordinator.
//
// Env vars:
//   LISTEN_PORT      — UDP port to bind (default 9500)
//   COORDINATOR_ADDR — host:port for the coordinator (default coordinator:9500)
// ============================================================

import dgram from "node:dgram";
import { PrologEngine } from "../../../src/prolog-engine.js";
import { loadString } from "../../../src/loader.js";
import { serialize, deserialize } from "../../../src/sync.js";

var atom     = PrologEngine.atom;
var variable = PrologEngine.variable;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;

// ── Configuration ───────────────────────────────────────────

var LISTEN_PORT = parseInt(process.env.LISTEN_PORT || "9500", 10);
var COORDINATOR_ADDR = process.env.COORDINATOR_ADDR || "coordinator:9500";

function parseAddr(addr) {
  var idx = addr.lastIndexOf(":");
  if (idx === -1) {
    return { host: addr, port: 9500 };
  }
  return {
    host: addr.substring(0, idx),
    port: parseInt(addr.substring(idx + 1), 10)
  };
}

var coordinator = parseAddr(COORDINATOR_ADDR);

// ── Prolog engine setup ─────────────────────────────────────

var engine = new PrologEngine();

// Signal policy: which incoming facts we accept.
// The estimator accepts readings from online sensors and
// node_status updates from any node.
var RULES = [
  "on_signal(From, reading(From, Type, Val, Ts), assert) :-",
  "    node_role(estimator),",
  "    node_status(From, online).",
  "",
  "on_signal(From, node_status(From, Status), assert) :-",
  "    node_role(estimator)."
].join("\n");

loadString(engine, RULES);

// Assert this node's identity and role.
engine.addClause(compound("node_role", [atom("estimator")]));
engine.addClause(compound("node_id",   [atom("estimator")]));

// ── UDP transport ───────────────────────────────────────────

var sock = dgram.createSocket("udp4");

sock.on("error", function(err) {
  console.error("[estimator] socket error:", err.message);
  sock.close();
});

sock.on("message", function(msg, rinfo) {
  var payload;
  try {
    payload = JSON.parse(msg.toString());
  } catch (e) {
    console.error("[estimator] bad JSON from " + rinfo.address + ":" + rinfo.port);
    return;
  }

  if (!payload || payload.kind !== "signal") return;

  var fromId = payload.from;
  var fact   = deserialize(payload.fact);
  if (!fact || !fromId) return;

  // Query the signal policy to decide whether to accept this fact.
  var goal = compound("on_signal", [atom(fromId), fact, variable("Action")]);
  var result = engine.queryFirst(goal);

  var action = null;
  if (result) {
    var actionTerm = result.args[2];
    if (actionTerm.type === "atom") action = actionTerm.name;
  }

  if (action !== "assert") {
    console.log("[estimator] ignored signal from " + fromId +
                " (" + (fact.functor || fact.name || "?") + ")");
    return;
  }

  // Upsert the fact into the engine.
  upsertFact(fact, fromId);
});

sock.bind(LISTEN_PORT, function() {
  console.log("[estimator] node_id=estimator listening on UDP port " + LISTEN_PORT);
  console.log("[estimator] coordinator at " + coordinator.host + ":" + coordinator.port);
});

// ── Fact upsert ─────────────────────────────────────────────
//
// For reading/4 and node_status/2 we retract the old value
// before asserting the new one, so only the latest is kept.

function upsertFact(fact, fromId) {
  if (fact.type === "compound" && fact.functor === "reading" && fact.args.length === 4) {
    var nodeId     = fact.args[0].name;
    var sensorType = fact.args[1].name;
    var value      = fact.args[2].value;
    var timestamp  = fact.args[3].value;

    // Retract old reading for this node+type, then assert new one.
    engine.retractFirst(compound("reading", [
      atom(nodeId), atom(sensorType), variable("_V"), variable("_T")
    ]));
    engine.addClause(compound("reading", [
      atom(nodeId), atom(sensorType), num(value), num(timestamp)
    ]));

    console.log("[estimator] reading: " + nodeId + " " + sensorType +
                " = " + value + " @ " + timestamp);

    // After upserting a reading, check if we can compute VPD.
    computeVPD(nodeId, timestamp);
    return;
  }

  if (fact.type === "compound" && fact.functor === "node_status" && fact.args.length === 2) {
    var nid    = fact.args[0].name;
    var status = fact.args[1].name;

    engine.retractFirst(compound("node_status", [atom(nid), variable("_S")]));
    engine.addClause(compound("node_status", [atom(nid), atom(status)]));

    console.log("[estimator] node_status: " + nid + " -> " + status);
    return;
  }

  // Fallback: plain assert (no upsert).
  engine.addClause(fact);
}

// ── VPD computation (Magnus formula) ────────────────────────
//
// VPD (Vapor Pressure Deficit) quantifies how far the air is
// from saturation. It requires both temperature and humidity
// readings for the same sensor.
//
// In QuickJS with BigDecimal:
//   const es = BigDecimal("0.6108") * BigDecimal.exp(
//     BigDecimal("17.27") * BigDecimal(temp) / (BigDecimal(temp) + BigDecimal("237.3"))
//   );
// IEEE 754 doubles accumulate ~0.001 kPa drift over 24h of readings.
// BigDecimal eliminates this, critical for VPD-based irrigation decisions.

function computeVPD(sensorId, timestamp) {
  // Look up the latest temperature reading for this sensor.
  var tempResult = engine.queryFirst(
    compound("reading", [atom(sensorId), atom("temperature"), variable("V"), variable("T")])
  );

  // Look up the latest humidity reading for this sensor.
  var humResult = engine.queryFirst(
    compound("reading", [atom(sensorId), atom("humidity"), variable("V"), variable("T")])
  );

  if (!tempResult || !humResult) {
    // Need both readings before we can compute VPD.
    return;
  }

  var temp     = tempResult.args[2].value;
  var humidity = humResult.args[2].value;

  // Magnus formula: saturated vapor pressure (kPa)
  // In production QuickJS, this would use BigDecimal for precision.
  var es = 0.6108 * Math.exp(17.27 * temp / (temp + 237.3));
  var ea = es * humidity / 100;
  var vpd = Math.round((es - ea) * 100);  // centikPa (integer for Prolog)

  console.log("[estimator] VPD for " + sensorId + ": " + vpd +
              " centikPa (temp=" + temp + ", humidity=" + humidity + ")");

  // Upsert the estimate locally.
  engine.retractFirst(compound("estimate", [
    atom("vpd"), atom(sensorId), variable("_V"), variable("_C"), variable("_T")
  ]));
  engine.addClause(compound("estimate", [
    atom("vpd"), atom(sensorId), num(vpd), num(100), num(timestamp)
  ]));

  // Send the estimate to the coordinator via UDP.
  var estimateFact = compound("estimate", [
    atom("vpd"), atom(sensorId), num(vpd), num(100), num(timestamp)
  ]);

  var payload = {
    kind: "signal",
    from: "estimator",
    fact: serialize(estimateFact)
  };

  var buf = Buffer.from(JSON.stringify(payload));
  sock.send(buf, 0, buf.length, coordinator.port, coordinator.host, function(err) {
    if (err) {
      console.error("[estimator] failed to send estimate:", err.message);
    } else {
      console.log("[estimator] sent VPD estimate to coordinator for " + sensorId);
    }
  });
}
