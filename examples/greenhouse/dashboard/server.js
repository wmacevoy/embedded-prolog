// ============================================================
// dashboard/server.js — Greenhouse coordinator + web dashboard
//
// Runs under Bun in Docker. Combines:
//   1. A Prolog engine with signal policy, alerts, thresholds
//   2. A UDP listener for mesh signals from sensors/estimator
//   3. An HTTP server with SSE for the browser dashboard
//
// Env vars:
//   LISTEN_PORT  — UDP port to bind (default 9500)
//   HTTP_PORT    — HTTP server port (default 3000)
//   GATEWAY_ADDR — host:port for the gateway node (default gateway:9500)
// ============================================================

import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrologEngine, listToArray } from "../../../src/prolog-engine.js";
import { loadString } from "../../../src/loader.js";
import { serialize, deserialize } from "../../../src/sync.js";

var atom     = PrologEngine.atom;
var variable = PrologEngine.variable;
var compound = PrologEngine.compound;
var num      = PrologEngine.num;

// ── Configuration ─────────────────────────────────────────────

var LISTEN_PORT  = parseInt(process.env.LISTEN_PORT  || "9500", 10);
var HTTP_PORT    = parseInt(process.env.HTTP_PORT     || "3000", 10);
var GATEWAY_ADDR = process.env.GATEWAY_ADDR || "gateway:9500";

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

var gateway = parseAddr(GATEWAY_ADDR);

// ── Resolve __dirname for serving static files ────────────────

var __filename = fileURLToPath(import.meta.url);
var __dirname  = dirname(__filename);

// ── Prolog engine setup ───────────────────────────────────────

var engine = new PrologEngine();

var RULES = [
  "threshold(temperature, 5, 40).",
  "threshold(humidity, 20, 85).",
  "threshold(vpd, 40, 160).",
  "",
  "on_signal(From, reading(From, Type, Val, Ts), assert) :-",
  "    node_role(coordinator),",
  "    node_status(From, online).",
  "on_signal(estimator, estimate(Type, Node, Val, Confidence, Ts), assert) :-",
  "    node_role(coordinator).",
  "on_signal(From, node_status(From, Status), assert) :-",
  "    node_role(coordinator).",
  "",
  "alert(Node, temperature, high) :-",
  "    reading(Node, temperature, Val, Ts),",
  "    threshold(temperature, Min, Max), Val > Max.",
  "alert(Node, temperature, low) :-",
  "    reading(Node, temperature, Val, Ts),",
  "    threshold(temperature, Min, Max), Val < Min.",
  "alert(Node, humidity, high) :-",
  "    reading(Node, humidity, Val, Ts),",
  "    threshold(humidity, Min, Max), Val > Max.",
  "alert(Node, humidity, low) :-",
  "    reading(Node, humidity, Val, Ts),",
  "    threshold(humidity, Min, Max), Val < Min.",
  "alert(Node, vpd, high) :-",
  "    estimate(vpd, Node, Val, Confidence, Ts),",
  "    threshold(vpd, Min, Max), Val > Max.",
  "alert(Node, vpd, low) :-",
  "    estimate(vpd, Node, Val, Confidence, Ts),",
  "    threshold(vpd, Min, Max), Val < Min.",
  "",
  "all_alerts(Alerts) :- findall(alert(N,T,L), alert(N,T,L), Alerts).",
  "online_nodes(Nodes) :- findall(N, node_status(N, online), Nodes).",
  "mesh_status(critical) :- alert(A, B, C).",
  "mesh_status(normal) :- not(alert(A, B, C))."
].join("\n");

loadString(engine, RULES);

// Assert this node's identity and role.
engine.addClause(compound("node_role", [atom("coordinator")]));
engine.addClause(compound("node_id",   [atom("coordinator")]));

// ── SSE client management ─────────────────────────────────────

var sseClients = new Set();

function notifyClients() {
  var data = JSON.stringify(getState());
  var payload = "data: " + data + "\n\n";
  for (var client of sseClients) {
    try {
      client.controller.enqueue(payload);
    } catch (e) {
      // Client disconnected; remove on next iteration
      sseClients.delete(client);
    }
  }
}

// ── State extraction ──────────────────────────────────────────
//
// Queries the Prolog engine to build a JSON-friendly snapshot
// of the current mesh state.

function getState() {
  // Mesh status: normal or critical
  var statusResult = engine.queryFirst(compound("mesh_status", [variable("S")]));
  var status = statusResult ? statusResult.args[0].name : "unknown";

  // Online nodes
  var nodesResult = engine.queryFirst(compound("online_nodes", [variable("N")]));
  var onlineNodes = [];
  if (nodesResult) {
    var nodeList = listToArray(nodesResult.args[0]);
    for (var i = 0; i < nodeList.length; i++) {
      onlineNodes.push(nodeList[i].name);
    }
  }

  // All readings: reading(Node, Type, Value, Timestamp)
  var readingResults = engine.query(
    compound("reading", [variable("N"), variable("T"), variable("V"), variable("Ts")]),
    100
  );
  var readings = [];
  for (var i = 0; i < readingResults.length; i++) {
    var r = readingResults[i];
    readings.push({
      node:  r.args[0].name,
      type:  r.args[1].name,
      value: r.args[2].value,
      ts:    r.args[3].value
    });
  }

  // All alerts: alert(Node, Type, Level)
  var alertResults = engine.queryFirst(compound("all_alerts", [variable("A")]));
  var alerts = [];
  if (alertResults) {
    var alertList = listToArray(alertResults.args[0]);
    for (var i = 0; i < alertList.length; i++) {
      var a = alertList[i];
      alerts.push({
        node:  a.args[0].name,
        type:  a.args[1].name,
        level: a.args[2].name
      });
    }
  }

  // All estimates: estimate(Type, Node, Value, Confidence, Timestamp)
  var estimateResults = engine.query(
    compound("estimate", [variable("T"), variable("N"), variable("V"), variable("C"), variable("Ts")]),
    100
  );
  var estimates = [];
  for (var i = 0; i < estimateResults.length; i++) {
    var e = estimateResults[i];
    estimates.push({
      type:       e.args[0].name,
      node:       e.args[1].name,
      value:      e.args[2].value,
      confidence: e.args[3].value,
      ts:         e.args[4].value
    });
  }

  // Thresholds
  var thresholdTypes = ["temperature", "humidity", "vpd"];
  var thresholds = {};
  for (var i = 0; i < thresholdTypes.length; i++) {
    var tType = thresholdTypes[i];
    var tResult = engine.queryFirst(
      compound("threshold", [atom(tType), variable("Min"), variable("Max")])
    );
    if (tResult) {
      thresholds[tType] = {
        min: tResult.args[1].value,
        max: tResult.args[2].value
      };
    }
  }

  return {
    status:      status,
    onlineNodes: onlineNodes,
    readings:    readings,
    alerts:      alerts,
    estimates:   estimates,
    thresholds:  thresholds
  };
}

// ── Signal handling with upsert ───────────────────────────────
//
// When a mesh signal arrives via UDP, we query the Prolog signal
// policy to decide whether to accept it. Accepted facts are
// upserted (old value retracted, new value asserted).

function handleSignal(from, fact) {
  var goal = compound("on_signal", [atom(from), fact, variable("Action")]);
  var result = engine.queryFirst(goal);

  if (!result) {
    console.log("[dashboard] ignored signal from " + from +
                " (" + (fact.functor || fact.name || "?") + ")");
    return;
  }

  var action = result.args[2];
  if (action.type !== "atom" || action.name !== "assert") return;

  // Upsert for known fact types
  if (fact.functor === "reading" && fact.args.length === 4) {
    engine.retractFirst(compound("reading", [
      fact.args[0], fact.args[1], variable("_V"), variable("_T")
    ]));
    engine.addClause(fact);
    console.log("[dashboard] reading: " + fact.args[0].name + " " +
                fact.args[1].name + " = " + fact.args[2].value);
  } else if (fact.functor === "node_status" && fact.args.length === 2) {
    engine.retractFirst(compound("node_status", [
      fact.args[0], variable("_S")
    ]));
    engine.addClause(fact);
    console.log("[dashboard] node_status: " + fact.args[0].name +
                " -> " + fact.args[1].name);
  } else if (fact.functor === "estimate" && fact.args.length === 5) {
    engine.retractFirst(compound("estimate", [
      fact.args[0], fact.args[1], variable("_V"), variable("_C"), variable("_T")
    ]));
    engine.addClause(fact);
    console.log("[dashboard] estimate: " + fact.args[0].name + " " +
                fact.args[1].name + " = " + fact.args[2].value);
  } else {
    engine.addClause(fact);
    console.log("[dashboard] asserted: " + (fact.functor || fact.name));
  }

  // Push updated state to all SSE clients
  notifyClients();
}

// ── Send a fact to the gateway ────────────────────────────────

function sendToGateway(fact) {
  var payload = JSON.stringify({
    kind: "signal",
    from: "coordinator",
    fact: serialize(fact)
  });
  var buf = Buffer.from(payload);
  udpSock.send(buf, 0, buf.length, gateway.port, gateway.host, function(err) {
    if (err) {
      console.error("[dashboard] failed to send to gateway:", err.message);
    }
  });
}

// ── Send a fact to a sensor ───────────────────────────────────
//
// In Docker Compose, sensor services are reachable by their
// service name. We send threshold updates via UDP.

function sendToNode(nodeAddr, fact) {
  var target = parseAddr(nodeAddr);
  var payload = JSON.stringify({
    kind: "signal",
    from: "coordinator",
    fact: serialize(fact)
  });
  var buf = Buffer.from(payload);
  udpSock.send(buf, 0, buf.length, target.port, target.host, function(err) {
    if (err) {
      console.error("[dashboard] failed to send to " + nodeAddr + ":", err.message);
    }
  });
}

// ── UDP transport ─────────────────────────────────────────────

var udpSock = dgram.createSocket("udp4");

udpSock.on("error", function(err) {
  console.error("[dashboard] socket error:", err.message);
  udpSock.close();
});

udpSock.on("message", function(msg, rinfo) {
  var payload;
  try {
    payload = JSON.parse(msg.toString());
  } catch (e) {
    console.error("[dashboard] bad JSON from " + rinfo.address + ":" + rinfo.port);
    return;
  }

  if (!payload || payload.kind !== "signal") return;

  var fromId = payload.from;
  var fact   = deserialize(payload.fact);
  if (!fact || !fromId) return;

  handleSignal(fromId, fact);
});

udpSock.bind(LISTEN_PORT, function() {
  console.log("[dashboard] UDP listening on port " + LISTEN_PORT);
  console.log("[dashboard] gateway at " + gateway.host + ":" + gateway.port);
});

// ── HTTP server (Bun.serve) ───────────────────────────────────

// Read the static HTML file once at startup.
var indexHtml = readFileSync(join(__dirname, "index.html"), "utf-8");

Bun.serve({
  port: HTTP_PORT,

  fetch: function(req) {
    var url = new URL(req.url);

    // ── GET / — serve the dashboard HTML ──────────────────
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // ── GET /api/state — JSON snapshot ────────────────────
    if (req.method === "GET" && url.pathname === "/api/state") {
      return new Response(JSON.stringify(getState()), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // ── GET /api/events — SSE stream ──────────────────────
    if (req.method === "GET" && url.pathname === "/api/events") {
      var client = { controller: null };

      var stream = new ReadableStream({
        start: function(controller) {
          client.controller = controller;
          sseClients.add(client);
          // Send initial state immediately
          var initial = "data: " + JSON.stringify(getState()) + "\n\n";
          controller.enqueue(initial);
        },
        cancel: function() {
          sseClients.delete(client);
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type":  "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection":    "keep-alive"
        }
      });
    }

    // ── POST /api/threshold — update a threshold ──────────
    if (req.method === "POST" && url.pathname === "/api/threshold") {
      return req.json().then(function(body) {
        var type = body.type;
        var min  = body.min;
        var max  = body.max;

        if (!type || min === undefined || max === undefined) {
          return new Response(JSON.stringify({ error: "missing type, min, or max" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Upsert the threshold in the Prolog engine
        engine.retractFirst(compound("threshold", [
          atom(type), variable("_Min"), variable("_Max")
        ]));
        engine.addClause(compound("threshold", [
          atom(type), num(min), num(max)
        ]));

        console.log("[dashboard] threshold updated: " + type +
                    " min=" + min + " max=" + max);

        // Push updated state to SSE clients
        notifyClients();

        // Broadcast the new threshold to sensors via the gateway
        var thresholdFact = compound("threshold", [
          atom(type), num(min), num(max)
        ]);
        sendToGateway(thresholdFact);

        return new Response(JSON.stringify(getState()), {
          headers: { "Content-Type": "application/json" }
        });
      });
    }

    // ── 404 fallback ──────────────────────────────────────
    return new Response("Not Found", { status: 404 });
  }
});

console.log("[dashboard] HTTP server on port " + HTTP_PORT);
console.log("[dashboard] Endpoints: GET /, /api/state, /api/events  POST /api/threshold");
