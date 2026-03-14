// ============================================================
// node.js — GreenhouseNode: engine + reactive + transport
//
// Incoming signals pass through Prolog ephemeral/react rules.
// If accepted, the react rule upserts facts; otherwise dropped.
// Outgoing messages are expressed via send/2 in react rules.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, SyncEngine } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { persist } from "../../src/persist.js";
import { buildGreenhouseKB } from "./greenhouse-kb.js";

const { atom, variable, compound, num } = PrologEngine;

export class GreenhouseNode {
  /**
   * @param {object} options
   * @param {string} options.id — unique node identifier
   * @param {string} options.role — "coordinator", "sensor", "estimator", "gateway"
   * @param {object} options.transport — SimTransport or UDP transport
   * @param {object} [options.db] — SQL adapter for persistence (optional)
   */
  constructor(options) {
    this.id = options.id;
    this.role = options.role;
    this.transport = options.transport;
    this._signalLog = [];

    const engine = buildGreenhouseKB(PrologEngine, this.id, this.role);
    const reactive = createReactiveEngine(engine);

    // Attach persistence — ephemeral/1 is already registered by
    // createReactiveEngine, so ephemeral scopes = SQL transactions.
    if (options.db) {
      this.db = persist(engine, options.db);
    }

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

    const result = this.engine.queryWithSends(
      compound("handle_signal", [atom(fromAddress), fact])
    );

    this._signalLog.push({
      from: fromAddress,
      fact: fact,
      accepted: result.result !== null
    });

    if (result.result) {
      // Dispatch all sends from Prolog react rules
      for (var i = 0; i < result.sends.length; i++) {
        var s = result.sends[i];
        this.transport.send(s.target.name, {
          kind: "signal",
          from: this.id,
          fact: serialize(s.fact)
        });
      }
      this.reactive.bump();
    }
  }

  // ── Sending ─────────────────────────────────────────────

  send(toNodeId, fact) {
    this.transport.send(toNodeId, {
      kind: "signal",
      from: this.id,
      fact: serialize(fact)
    });
  }

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
