// ============================================================
// node.js — MeshNode: Prolog engine + reactive layer + transport
//
// Incoming signals pass through ephemeral/react(QJSON_object).
// If accepted, the react rule upserts facts; otherwise dropped.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, SyncEngine } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { buildMeshKB } from "./mesh-kb.js";

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

    // Save the engine's built-in ephemeral/1 (fires _fireReact)
    const nativeEphemeral = engine.builtins["ephemeral/1"];

    // Wrap in reactive layer (auto-bump on assert/retract)
    const reactive = createReactiveEngine(engine);

    // Restore engine's native ephemeral/1 — the reactive layer overrides
    // it with old assert/solve/retract, but we want _fireReact dispatch.
    engine.builtins["ephemeral/1"] = nativeEphemeral;

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

    // Track whether any react rule mutated the DB (= accepted)
    let accepted = false;
    const markAccepted = function() { accepted = true; };
    this.engine.onAssert.push(markAccepted);
    this.engine.onRetract.push(markAccepted);

    const result = this.engine.queryWithSends(
      compound("ephemeral", [
        PrologEngine.object([
          { key: "type", value: atom("signal") },
          { key: "from", value: atom(fromAddress) },
          { key: "fact", value: fact }
        ])
      ])
    );

    // Remove our temporary mutation tracker
    this.engine.onAssert.pop();
    this.engine.onRetract.pop();

    this._signalLog.push({
      from: fromAddress,
      fact: fact,
      accepted: accepted
    });

    for (var i = 0; i < result.sends.length; i++) {
      var s = result.sends[i];
      this.transport.send(s.target.name, {
        kind: "signal",
        from: this.id,
        fact: serialize(s.fact)
      });
    }
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
