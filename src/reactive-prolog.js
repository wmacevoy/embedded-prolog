// ============================================================
// reactive-prolog.js — Reactive queries over a Prolog engine
//
// Auto-bump: engine.onAssert / onRetract set a dirty flag.
// After any query that mutated facts, generation bumps once.
// No manual bump() needed (but still available).
//
// Portable: same constraints as reactive.js
// ============================================================

import { createSignal, createMemo, createEffect } from "./reactive.js";

function createReactiveEngine(engineOrFactory) {
  var engine = typeof engineOrFactory === "function"
    ? engineOrFactory() : engineOrFactory;

  var pair = createSignal(0);
  var generation = pair[0];
  var setGeneration = pair[1];
  var dirty = false;

  function bump() {
    setGeneration(function(g) { return g + 1; });
  }

  // Track mutations via engine callbacks
  engine.onAssert.push(function() { dirty = true; });
  engine.onRetract.push(function() { dirty = true; });

  // Wrap engine query methods: auto-bump after mutating queries
  var _origQuery = engine.query;
  var _origQueryFirst = engine.queryFirst;
  var _origQueryWithSends = engine.queryWithSends;

  engine.query = function(goal, limit) {
    dirty = false;
    var result = _origQuery.call(engine, goal, limit);
    if (dirty) { dirty = false; bump(); }
    return result;
  };

  engine.queryFirst = function(goal) {
    dirty = false;
    var result = _origQueryFirst.call(engine, goal);
    if (dirty) { dirty = false; bump(); }
    return result;
  };

  engine.queryWithSends = function(goal) {
    dirty = false;
    var result = _origQueryWithSends.call(engine, goal);
    if (dirty) { dirty = false; bump(); }
    return result;
  };

  function act(goal) {
    // With auto-bump, this is equivalent to engine.queryFirst(goal).
    return engine.queryFirst(goal);
  }

  function _createQuery(goalFn, limit) {
    return createMemo(function() {
      generation();
      return engine.query(goalFn(), limit || 50);
    });
  }

  function _createQueryFirst(goalFn) {
    return createMemo(function() {
      generation();
      return engine.queryFirst(goalFn());
    });
  }

  function onUpdate(fn) {
    createEffect(function() {
      generation();
      fn();
    });
  }

  return {
    engine: engine,
    generation: generation,
    bump: bump,
    act: act,
    createQuery: _createQuery,
    createQueryFirst: _createQueryFirst,
    onUpdate: onUpdate
  };
}

if (typeof exports !== "undefined") {
  exports.createReactiveEngine = createReactiveEngine;
}
export { createReactiveEngine };
