// ============================================================
// y8-datalog.js — Reactive Datalog over QJSON (ES5)
//
// Portable: no let/const, no arrows, no for-of.
// Requires: better-sqlite3 (or bun:sqlite) with qjson_ext loaded.
//
// Usage:
//   var db = y8Datalog(sqliteDb);
//   db.setup();
//   db.assertFact("parent", ["alice", "bob"]);
//   db.resolve("parent", [null, "bob"]);
// ============================================================

import { qjsonSqlAdapter } from '../vendor/qjson/src/qjson-sql.js';
import { qjson_parse, qjson_stringify, Unbound } from '../vendor/qjson/src/qjson.js';

function y8Datalog(sqliteDb, options) {
  var _prefix = (options && options.prefix) || "qjson_";
  var _adapter = qjsonSqlAdapter(sqliteDb, { prefix: _prefix });
  var _rootId = (options && options.rootId) || null;
  var _natives = {};
  var _sends = [];
  var _reactRules = [];
  var _onAssert = [];
  var _onRetract = [];
  var _hasExt = false;

  function _loadExt() {
    // Try loading qjson_ext for cross-path comparison
    try {
      sqliteDb.loadExtension && sqliteDb.loadExtension(
        require("path").resolve(__dirname, "..", "vendor", "qjson", "qjson_ext")
      );
      _hasExt = true;
    } catch(e) {
      // Extension not available — cross-path queries won't work
    }
  }

  function _getRoot() {
    return _adapter.load(_rootId);
  }

  function _saveRoot(root) {
    if (_rootId !== null) _adapter.remove(_rootId);
    _rootId = _adapter.store(root);
    _adapter.commit();
  }

  function _getSet(root, predicate) {
    if (!root || typeof root !== "object") return null;
    var set = root[predicate];
    if (!set) return null;
    // Set is an object or QMap
    if (typeof set === "object" && set.$qjson === "map") return set;
    if (typeof set === "object" && !Array.isArray(set)) return set;
    return null;
  }

  function _setEntries(set) {
    if (!set) return [];
    if (set.$qjson === "map") return set.entries || [];
    var keys = Object.keys(set);
    var entries = [];
    for (var i = 0; i < keys.length; i++) {
      entries.push([keys[i], set[keys[i]]]);
    }
    return entries;
  }

  function _matches(fact, pattern) {
    if (!Array.isArray(fact) || !Array.isArray(pattern)) return false;
    if (fact.length !== pattern.length) return false;
    for (var i = 0; i < fact.length; i++) {
      if (pattern[i] === null) continue;
      if (typeof pattern[i] === "object" && pattern[i].$qjson === "unbound") continue;
      if (fact[i] !== pattern[i]) return false;
    }
    return true;
  }

  function _fireReact(eventType, predicate, fact) {
    for (var i = 0; i < _reactRules.length; i++) {
      var rule = _reactRules[i];
      if (rule.pattern === eventType || rule.pattern === "*") {
        try { rule.handler(eventType, predicate, fact, api); } catch(e) {}
      }
    }
  }

  var api = {
    setup: function() {
      _adapter.setup();
      _loadExt();
      if (_rootId === null) {
        _rootId = _adapter.store({});
        _adapter.commit();
      }
    },

    rootId: function() { return _rootId; },

    // ── Facts ────────────────────────────────────────────

    assertFact: function(predicate, args) {
      var root = _getRoot();
      if (!root) root = {};
      var set = root[predicate];
      if (!set) {
        set = { $qjson: "map", entries: [] };
        root[predicate] = set;
      }
      var entries = set.$qjson === "map" ? set.entries : [];
      var factTuple = args.slice();

      // Check duplicate
      for (var i = 0; i < entries.length; i++) {
        var k = entries[i][0];
        if (Array.isArray(k) && k.length === factTuple.length) {
          var eq = true;
          for (var j = 0; j < k.length; j++) {
            if (k[j] !== factTuple[j]) { eq = false; break; }
          }
          if (eq) return; // already exists
        }
      }

      entries.push([factTuple, true]);
      if (set.$qjson !== "map") {
        root[predicate] = { $qjson: "map", entries: entries };
      }
      _saveRoot(root);

      for (var i = 0; i < _onAssert.length; i++) _onAssert[i](predicate, factTuple);
      _fireReact("assert", predicate, factTuple);
    },

    retract: function(predicate, args) {
      var root = _getRoot();
      if (!root) return false;
      var set = root[predicate];
      if (!set) return false;

      var entries = set.$qjson === "map" ? set.entries : [];
      var factTuple = args.slice();
      var newEntries = [];
      var found = false;

      for (var i = 0; i < entries.length; i++) {
        var k = entries[i][0];
        if (!found && Array.isArray(k) && k.length === factTuple.length) {
          var eq = true;
          for (var j = 0; j < k.length; j++) {
            if (k[j] !== factTuple[j]) { eq = false; break; }
          }
          if (eq) { found = true; continue; }
        }
        newEntries.push(entries[i]);
      }

      if (!found) return false;
      root[predicate] = { $qjson: "map", entries: newEntries };
      _saveRoot(root);

      for (var i = 0; i < _onRetract.length; i++) _onRetract[i](predicate, factTuple);
      _fireReact("retract", predicate, factTuple);
      return true;
    },

    retractAll: function(predicate, pattern) {
      var root = _getRoot();
      if (!root) return 0;
      var set = root[predicate];
      if (!set) return 0;

      var entries = set.$qjson === "map" ? set.entries : [];
      var keep = [];
      var removed = [];

      for (var i = 0; i < entries.length; i++) {
        if (_matches(entries[i][0], pattern)) {
          removed.push(entries[i][0]);
        } else {
          keep.push(entries[i]);
        }
      }

      if (removed.length === 0) return 0;
      root[predicate] = { $qjson: "map", entries: keep };
      _saveRoot(root);

      for (var r = 0; r < removed.length; r++) {
        for (var i = 0; i < _onRetract.length; i++) _onRetract[i](predicate, removed[r]);
        _fireReact("retract", predicate, removed[r]);
      }
      return removed.length;
    },

    // ── Query ────────────────────────────────────────────

    query: function(predicate, pattern) {
      var root = _getRoot();
      if (!root) return [];
      var set = root[predicate];
      if (!set) return [];

      var entries = set.$qjson === "map" ? set.entries : [];
      var results = [];

      for (var i = 0; i < entries.length; i++) {
        var fact = entries[i][0];
        if (!pattern || _matches(fact, pattern)) {
          results.push(fact);
        }
      }
      return results;
    },

    // ── Resolve ──────────────────────────────────────────

    resolve: function(predicate, pattern) {
      var results = [];

      // 1. Direct fact lookup
      var facts = api.query(predicate, pattern);
      for (var i = 0; i < facts.length; i++) {
        var bindings = {};
        if (pattern) {
          for (var j = 0; j < pattern.length; j++) {
            if (pattern[j] && typeof pattern[j] === "object" && pattern[j].$qjson === "unbound" && pattern[j].name) {
              bindings[pattern[j].name] = facts[i][j];
            }
          }
        }
        results.push(bindings);
      }

      // 2. Rule resolution (requires extension for cross-path queries)
      // TODO: compile rules to SQL via qjson_select extension

      // Deduplicate
      var seen = {};
      var unique = [];
      for (var i = 0; i < results.length; i++) {
        var key = JSON.stringify(results[i]);
        if (!seen[key]) {
          seen[key] = true;
          unique.push(results[i]);
        }
      }
      return unique;
    },

    // ── Rules ────────────────────────────────────────────

    addRule: function(clause) {
      var head = clause[0];
      var predName = head[0];
      var root = _getRoot();
      if (!root) root = {};
      if (!root.rules) root.rules = {};
      if (!root.rules[predName]) root.rules[predName] = { $qjson: "map", entries: [] };

      var ruleSet = root.rules[predName];
      var entries = ruleSet.$qjson === "map" ? ruleSet.entries : [];
      // Check duplicate
      var clauseStr = JSON.stringify(clause);
      for (var i = 0; i < entries.length; i++) {
        if (JSON.stringify(entries[i][0]) === clauseStr) return;
      }
      entries.push([clause, true]);
      _saveRoot(root);
    },

    // ── React ────────────────────────────────────────────

    addReact: function(pattern, handler) {
      _reactRules.push({ pattern: pattern, handler: handler });
    },

    // ── Ephemeral ────────────────────────────────────────

    ephemeral: function(eventType, predicate, fact) {
      _fireReact(eventType, predicate, fact);
    },

    // ── Native ───────────────────────────────────────────

    registerNative: function(name, fn) { _natives[name] = fn; },
    callNative: function(name, args) {
      if (!_natives[name]) return null;
      return _natives[name](args);
    },

    // ── Send ─────────────────────────────────────────────

    send: function(target, message) {
      _sends.push({ target: target, message: message });
    },
    collectSends: function() {
      var s = _sends.slice();
      _sends = [];
      return s;
    },

    // ── Callbacks ────────────────────────────────────────

    onAssert: _onAssert,
    onRetract: _onRetract
  };

  return api;
}

// ── Export ───────────────────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.y8Datalog = y8Datalog;
}
export { y8Datalog };
