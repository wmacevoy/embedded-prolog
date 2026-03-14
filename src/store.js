// ============================================================
// store.js — Key/value store shim over Y@ Prolog
//
// Effortless state. No Prolog knowledge needed.
//
//   var store = createStore();
//   store.set("count", 0);
//   store.get("count");         // → 0
//   store.on("count", fn);      // reactive
//
// Under the hood: Prolog facts kv(Key, Value), reactive
// engine, optional qsql persistence.
//
// Portable: ES5 style (var, function, no arrows).
// ============================================================

import { PrologEngine } from "./prolog-engine.js";
import { createReactiveEngine } from "./reactive-prolog.js";

// ── Value conversion ────────────────────────────────────────

function _toTerm(v) {
  if (v === null || v === undefined) return PrologEngine.atom("null");
  if (typeof v === "boolean") return PrologEngine.atom(v ? "true" : "false");
  if (typeof v === "number") return PrologEngine.num(v);
  if (typeof v === "string") return PrologEngine.atom(v);
  // Object/array → JSON string as atom
  return PrologEngine.atom(JSON.stringify(v));
}

function _fromTerm(t) {
  if (!t) return undefined;
  if (t.type === "num") return t.value;
  if (t.type === "atom") {
    if (t.name === "null") return null;
    if (t.name === "true") return true;
    if (t.name === "false") return false;
    var c = t.name.charAt(0);
    if (c === "{" || c === "[") {
      try { return JSON.parse(t.name); } catch(e) {}
    }
    return t.name;
  }
  return undefined;
}

// ── Store factory ───────────────────────────────────────────

function createStore(options) {
  var engine = new PrologEngine();

  // Register ephemeral/1
  engine.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    engine.clauses.push({ head: term, body: [] });
    try {
      engine.solve(rest, subst, counter, depth + 1, onSolution);
    } finally {
      engine.retractFirst(term);
    }
  };

  var reactive = createReactiveEngine(engine);

  // Optional persistence
  if (options && options.persist) {
    options.persist(engine);
  }

  var _atom = PrologEngine.atom;
  var _comp = PrologEngine.compound;
  var _var  = PrologEngine.variable;

  // Helper rule: atomic retract+assert in one query (single bump)
  engine.addClause(
    _comp("_kv_set", [_var("K"), _var("V")]),
    [_comp("retractall", [_comp("kv", [_var("K"), _var("_Old")])]),
     _comp("assert", [_comp("kv", [_var("K"), _var("V")])])]
  );

  function _get(key) {
    var r = engine.queryFirst(_comp("kv", [_atom(key), _var("V")]));
    return r ? _fromTerm(r.args[1]) : undefined;
  }

  var _watchers = {};

  reactive.onUpdate(function() {
    for (var key in _watchers) {
      var fns = _watchers[key];
      if (!fns || fns.length === 0) continue;
      var val = _get(key);
      for (var i = 0; i < fns.length; i++) {
        if (fns[i]._prev !== val) {
          fns[i]._prev = val;
          fns[i](val);
        }
      }
    }
  });

  var store = {
    get: function(key) {
      return _get(key);
    },

    set: function(key, value) {
      engine.queryFirst(_comp("_kv_set", [_atom(key), _toTerm(value)]));
    },

    delete: function(key) {
      engine.queryFirst(_comp("retractall", [_comp("kv", [_atom(key), _var("_D")])]));
    },

    has: function(key) {
      return _get(key) !== undefined;
    },

    keys: function() {
      var results = engine.query(_comp("kv", [_var("K"), _var("V")]));
      var out = [];
      for (var i = 0; i < results.length; i++) out.push(results[i].args[0].name);
      return out;
    },

    entries: function() {
      var results = engine.query(_comp("kv", [_var("K"), _var("V")]));
      var out = [];
      for (var i = 0; i < results.length; i++) {
        out.push([results[i].args[0].name, _fromTerm(results[i].args[1])]);
      }
      return out;
    },

    on: function(key, fn) {
      fn._prev = _get(key);
      if (!_watchers[key]) _watchers[key] = [];
      _watchers[key].push(fn);
      return function off() {
        var fns = _watchers[key];
        if (fns) {
          var idx = -1;
          for (var i = 0; i < fns.length; i++) { if (fns[i] === fn) { idx = i; break; } }
          if (idx >= 0) fns.splice(idx, 1);
        }
      };
    },

    // Escape hatch
    engine: engine,
    reactive: reactive
  };

  return store;
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.createStore = createStore;
  exports._toTerm = _toTerm;
  exports._fromTerm = _fromTerm;
}
export { createStore, _toTerm, _fromTerm };
