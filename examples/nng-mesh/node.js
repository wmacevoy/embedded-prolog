// ============================================================
// node.js — MeshNode: Prolog engine + reactive layer + transport
//
// Wires together PrologEngine, SyncEngine, reactive signals,
// and a transport (SimTransport or real NNG). Incoming signals
// pass through Prolog policy rules before touching the database.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, termEq, SyncEngine } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { buildMeshKB, updateReading, setNodeStatus } from "./mesh-kb.js";

const { atom, variable, compound, num } = PrologEngine;

export class MeshNode {
  /**
   * @param {object} options
   * @param {string} options.id — unique node identifier
   * @param {object} options.transport — SimTransport or NNG transport
   */
  constructor(options) {
    this.id = options.id;
    this.transport = options.transport;
    this._signalLog = [];

    // Build engine with mesh KB
    const engine = buildMeshKB(PrologEngine, this.id);

    // Wrap in reactive layer
    const reactive = createReactiveEngine(engine);

    // Create sync engine (bumps reactive generation on fact changes)
    const sync = new SyncEngine(engine, { onSync: reactive.bump });

    this.engine = engine;
    this.reactive = reactive;
    this.sync = sync;

    // Wire transport receive → signal policy
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

    // Determine action
    let action = null;
    if (result) {
      const actionTerm = result.args[2];
      if (actionTerm.type === "atom") action = actionTerm.name;
    }

    // Log the signal (for testing/debugging)
    this._signalLog.push({
      from: fromAddress,
      fact: fact,
      action: action || "ignore"
    });

    // Execute action
    if (action === "assert") {
      // For reading/4 facts, do upsert (retract old + assert new)
      if (fact.type === "compound" && fact.functor === "reading" && fact.args.length === 4) {
        const nodeId = fact.args[0].name;
        const sensorType = fact.args[1].name;
        const value = fact.args[2].value;
        const timestamp = fact.args[3].value;
        updateReading(this.engine, PrologEngine, nodeId, sensorType, value, timestamp);
        this.reactive.bump();
      } else if (fact.type === "compound" && fact.functor === "node_status" && fact.args.length === 2) {
        setNodeStatus(this.engine, PrologEngine, fact.args[0].name, fact.args[1].name);
        this.reactive.bump();
      } else {
        this.sync.assertFact(fact);
      }
    } else if (action === "retract") {
      this.sync.retractFact(fact);
    }
    // "ignore" or no match → do nothing
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

  /** Assert a fact locally (bypasses policy — for own state). */
  assertLocal(fact) {
    this.sync.assertFact(fact);
  }

  /** Retract a fact locally. */
  retractLocal(fact) {
    this.sync.retractFact(fact);
  }

  // ── Queries ─────────────────────────────────────────────

  query(goal, limit) {
    return this.engine.query(goal, limit);
  }

  queryFirst(goal) {
    return this.engine.queryFirst(goal);
  }

  // ── Cleanup ─────────────────────────────────────────────

  close() {
    this.transport.close();
  }
}
