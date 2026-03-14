// ============================================================
// persist.js — One-function database persistence for Y@ Prolog
//
// Portable: same constraints as prolog-engine.js (ES5, no deps).
//
// Usage:
//   persist(engine, sqliteAdapter(db));        // explicit adapter
//   persist(engine, db);                       // auto-detect better-sqlite3
//   persist(engine, adapter, null, {stringify: qjson_stringify, parse: qjson_parse});
//
// Adapter interface (6 methods):
//   setup()       — create table if needed
//   insert(key)   — upsert fact (ignore duplicate)
//   remove(key)   — delete fact by key
//   all()         — return all fact keys as list of strings
//   commit()      — commit transaction
//   close()       — release connection
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

// ── Auto-detect better-sqlite3 → semantic adapter ───────────

function _autoAdapter(db) {
  if (typeof db.insert === "function" && typeof db.setup === "function") {
    return db;  // already a semantic adapter
  }
  if (typeof db.prepare === "function" && typeof db.exec === "function") {
    // better-sqlite3 or bun:sqlite — wrap to semantic interface
    var cache = {};
    function stmt(sql) {
      if (!cache[sql]) cache[sql] = db.prepare(sql);
      return cache[sql];
    }
    return {
      setup:  function() { db.exec("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)"); },
      insert: function(key) { stmt("INSERT OR IGNORE INTO facts VALUES (?)").run(key); },
      remove: function(key) { stmt("DELETE FROM facts WHERE term = ?").run(key); },
      all:    function() { return stmt("SELECT term FROM facts").all().map(function(r) { return r.term; }); },
      commit: function() {},
      close:  function() { db.close(); }
    };
  }
  return db;  // assume it's already an adapter
}

// ── Main function ───────────────────────────────────────────

function persist(engine, db, predicates, codec) {
  var adapter = _autoAdapter(db);

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
  adapter.setup();

  var keys = adapter.all();
  for (var i = 0; i < keys.length; i++) {
    engine.addClause(_deser(_loads(keys[i])));
  }

  // ── Hook assert/1 ──────────────────────────────────────
  var origAssert = engine.builtins["assert/1"];

  engine.builtins["assert/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    if (_ok(term)) {
      adapter.insert(_key(term));
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
      adapter.insert(_key(head));
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
          adapter.remove(_key(ch));
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
}
export { persist };
