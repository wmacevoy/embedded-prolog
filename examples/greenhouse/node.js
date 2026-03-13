// ============================================================
// node.js — GreenhouseNode: engine + reactive + transport
//
// Wires together PrologEngine, SyncEngine, reactive signals,
// and a transport. Each node has a role (coordinator, sensor,
// estimator, gateway) that determines its signal policy.
//
// The estimator node automatically computes VPD when it has
// both temperature and humidity readings for a sensor.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, termEq, SyncEngine } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import {
  buildGreenhouseKB, updateReading, setNodeStatus,
  updateThreshold, updateEstimate
} from "./greenhouse-kb.js";

const { atom, variable, compound, num } = PrologEngine;

export class GreenhouseNode {
  /**
   * @param {object} options
   * @param {string} options.id — unique node identifier
   * @param {string} options.role — "coordinator", "sensor", "estimator", "gateway"
   * @param {object} options.transport — SimTransport or UDP transport
   */
  constructor(options) {
    this.id = options.id;
    this.role = options.role;
    this.transport = options.transport;
    this._signalLog = [];

    const engine = buildGreenhouseKB(PrologEngine, this.id, this.role);
    const reactive = createReactiveEngine(engine);
    const sync = new SyncEngine(engine, { onSync: reactive.bump });

    this.engine = engine;
    this.reactive = reactive;
    this.sync = sync;

    const self = this;
    this.transport.onReceive(function(fromAddress, payload) {
      self._handleSignal(fromAddress, payload);
    });
  }

  // ── Signal handling ─────────────────────────────────────

  _handleSignal(fromAddress, payload) {
    if (!payload || payload.kind !== "signal") return;

    const fact = deserialize(payload.fact);
    if (!fact) return;

    // Query the policy: on_signal(FromNode, Fact, Action)
    const goal = compound("on_signal", [atom(fromAddress), fact, variable("Action")]);
    const result = this.engine.queryFirst(goal);

    let action = null;
    if (result) {
      const actionTerm = result.args[2];
      if (actionTerm.type === "atom") action = actionTerm.name;
    }

    this._signalLog.push({
      from: fromAddress,
      fact: fact,
      action: action || "ignore"
    });

    if (action === "assert") {
      this._assertFact(fact, fromAddress);
    } else if (action === "retract") {
      this.sync.retractFact(fact);
    }
  }

  _assertFact(fact, fromAddress) {
    if (fact.type !== "compound") {
      this.sync.assertFact(fact);
      return;
    }

    // Upsert for specific fact types
    if (fact.functor === "reading" && fact.args.length === 4) {
      const nodeId = fact.args[0].name;
      const sensorType = fact.args[1].name;
      const value = fact.args[2].value;
      const timestamp = fact.args[3].value;
      updateReading(this.engine, PrologEngine, nodeId, sensorType, value, timestamp);
      this.reactive.bump();

      // Estimator: compute VPD when both readings available
      if (this.role === "estimator") {
        this._computeVPD(nodeId, timestamp);
      }
      return;
    }

    if (fact.functor === "node_status" && fact.args.length === 2) {
      setNodeStatus(this.engine, PrologEngine, fact.args[0].name, fact.args[1].name);
      this.reactive.bump();
      return;
    }

    if (fact.functor === "threshold" && fact.args.length === 3) {
      updateThreshold(this.engine, PrologEngine, fact.args[0].name, fact.args[1].value, fact.args[2].value);
      this.reactive.bump();
      return;
    }

    if (fact.functor === "estimate" && fact.args.length === 5) {
      updateEstimate(this.engine, PrologEngine,
        fact.args[0].name, fact.args[1].name,
        fact.args[2].value, fact.args[3].value, fact.args[4].value);
      this.reactive.bump();
      return;
    }

    // Default: plain assert
    this.sync.assertFact(fact);
  }

  // ── VPD computation (estimator role) ──────────────────

  _computeVPD(sensorId, timestamp) {
    const tempR = this.engine.queryFirst(
      compound("reading", [atom(sensorId), atom("temperature"), variable("V"), variable("T")])
    );
    const humR = this.engine.queryFirst(
      compound("reading", [atom(sensorId), atom("humidity"), variable("V"), variable("T")])
    );

    if (!tempR || !humR) return;

    const temp = tempR.args[2].value;
    const humidity = humR.args[2].value;

    // Magnus formula: saturated vapor pressure (kPa)
    const es = 0.6108 * Math.exp(17.27 * temp / (temp + 237.3));
    const ea = es * humidity / 100;
    // VPD in centikPa (integer) for Prolog comparison with thresholds
    const vpd = Math.round((es - ea) * 100);

    // Store locally
    updateEstimate(this.engine, PrologEngine, "vpd", sensorId, vpd, 100, timestamp);
    this.reactive.bump();

    // Send to coordinator
    this.send("coordinator", compound("estimate", [
      atom("vpd"), atom(sensorId), num(vpd), num(100), num(timestamp)
    ]));
  }

  // ── Sending ─────────────────────────────────────────────

  /** Send a fact to a specific node. */
  send(toNodeId, fact) {
    this.transport.send(toNodeId, {
      kind: "signal",
      from: this.id,
      fact: serialize(fact)
    });
  }

  /** Broadcast a fact to all peers. */
  broadcast(fact) {
    this.transport.broadcast({
      kind: "signal",
      from: this.id,
      fact: serialize(fact)
    });
  }

  // ── Local state ─────────────────────────────────────────

  assertLocal(fact) { this.sync.assertFact(fact); }
  retractLocal(fact) { this.sync.retractFact(fact); }

  // ── Queries ─────────────────────────────────────────────

  query(goal, limit) { return this.engine.query(goal, limit); }
  queryFirst(goal) { return this.engine.queryFirst(goal); }

  // ── Cleanup ─────────────────────────────────────────────

  close() { this.transport.close(); }
}
