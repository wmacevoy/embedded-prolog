// ============================================================
// persist.js — One-function database persistence for Y@ Prolog
//
// Portable: same constraints as prolog-engine.js (ES5, no deps).
// The caller provides a sync SQL adapter (e.g. better-sqlite3).
//
// Usage:
//   import { PrologEngine } from './prolog-engine.js';
//   import { persist } from './persist.js';
//   var Database = require('better-sqlite3');
//
//   var engine = new PrologEngine();
//   persist(engine, new Database('state.db'));
//   // assert/retract are now durable — facts survive restart
//
// Adapter interface (for custom backends):
//   { exec(sql), run(sql, params), all(sql) → [{term: "..."}] }
//
// If using ephemeral/react, call persist() AFTER createReactiveEngine().
// Ephemeral scopes become SQL transactions — all mutations inside one
// signal handler commit atomically.
// ============================================================

// ── Term serialization (inline, matches sync.js format) ─────

function _ser(t) {
  if (t.type === "atom") return { t: "a", n: t.name };
  if (t.type === "num")  return { t: "n", v: t.value };
  if (t.type === "compound") {
    var a = [];
    for (var i = 0; i < t.args.length; i++) a.push(_ser(t.args[i]));
    return { t: "c", f: t.functor, a: a };
  }
  return null;
}

function _deser(o) {
  if (o.t === "a") return { type: "atom", name: o.n };
  if (o.t === "n") return { type: "num", value: o.v };
  if (o.t === "c") {
    var a = [];
    for (var i = 0; i < o.a.length; i++) a.push(_deser(o.a[i]));
    return { type: "compound", functor: o.f, args: a };
  }
  return null;
}

// ── better-sqlite3 auto-wrapper ─────────────────────────────

function _wrapBetterSqlite3(db) {
  var cache = {};
  function stmt(sql) {
    if (!cache[sql]) cache[sql] = db.prepare(sql);
    return cache[sql];
  }
  return {
    exec: function(sql) { db.exec(sql); },
    run:  function(sql, params) { stmt(sql).run.apply(stmt(sql), params); },
    all:  function(sql) { return stmt(sql).all(); },
    commit: function() {}  // better-sqlite3 is autocommit
  };
}

// ── Main function ───────────────────────────────────────────

function persist(engine, db, predicates, codec) {
  var adapter;
  if (typeof db.prepare === "function" && typeof db.exec === "function") {
    adapter = _wrapBetterSqlite3(db);
  } else {
    adapter = db;
  }

  // codec: null = JSON; {stringify, parse} = custom (e.g. QJSON)
  // Parse optimization: try native JSON.parse first, fall back to codec.parse.
  // Native JSON.parse is C — almost zero cost for the 99.999% that is plain JSON.
  var _dumps = (codec && codec.stringify) || JSON.stringify;
  var _codec_parse = codec && codec.parse;
  var _loads = _codec_parse
    ? function(text) { try { return JSON.parse(text); } catch(e) { return _codec_parse(text); } }
    : JSON.parse;

  function _key(term) { return _dumps(_ser(term)); }

  var preds = predicates || null;
  var txnDepth = 0;

  function _ok(term) {
    if (!preds) return true;
    var key;
    if (term.type === "compound") key = term.functor + "/" + term.args.length;
    else if (term.type === "atom") key = term.name + "/0";
    else return false;
    return !!preds[key];
  }

  function _commit() {
    if (txnDepth === 0 && adapter.commit) adapter.commit();
  }

  // ── Create table + restore ──────────────────────────────
  adapter.exec("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)");

  var rows = adapter.all("SELECT term FROM facts");
  for (var i = 0; i < rows.length; i++) {
    engine.addClause(_deser(_loads(rows[i].term)));
  }

  // ── Hook assert/1 ──────────────────────────────────────
  var origAssert = engine.builtins["assert/1"];

  engine.builtins["assert/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    if (_ok(term)) {
      adapter.run("INSERT OR IGNORE INTO facts VALUES (?)", [_key(term)]);
      _commit();
    }
    origAssert(goal, rest, subst, counter, depth, onSolution);
  };
  engine.builtins["assertz/1"] = engine.builtins["assert/1"];

  // ── Hook addClause (covers programmatic additions) ──────
  var _origAddClause = engine.addClause;
  engine.addClause = function(head, body) {
    _origAddClause.call(engine, head, body);
    if ((!body || body.length === 0) && _ok(head)) {
      adapter.run("INSERT OR IGNORE INTO facts VALUES (?)", [_key(head)]);
      _commit();
    }
  };

  // ── Hook retractFirst (covers retract/1 + retractall/1) ─
  engine.retractFirst = function(head) {
    for (var i = 0; i < engine.clauses.length; i++) {
      var ch = engine.clauses[i].head;
      var cb = engine.clauses[i].body;
      if (engine.unify(head, ch, new Map()) !== null) {
        engine.clauses.splice(i, 1);
        if (cb.length === 0 && _ok(ch)) {
          adapter.run("DELETE FROM facts WHERE term = ?", [_key(ch)]);
          _commit();
        }
        return true;
      }
    }
    return false;
  };

  // ── Hook ephemeral/1 — ephemeral scope = SQL transaction ─
  if (engine.builtins["ephemeral/1"]) {
    var origEphemeral = engine.builtins["ephemeral/1"];
    engine.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
      txnDepth++;
      try {
        origEphemeral(goal, rest, subst, counter, depth, onSolution);
      } finally {
        txnDepth--;
        if (txnDepth === 0 && adapter.commit) adapter.commit();
      }
    };
  }

  return adapter;
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.persist = persist;
  exports._wrapBetterSqlite3 = _wrapBetterSqlite3;
}
export { persist, _wrapBetterSqlite3 };
