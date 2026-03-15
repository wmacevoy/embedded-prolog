// ============================================================
// persist.js — One-function database persistence for y8 Prolog
//
// Uses engine.onAssert / engine.onRetract callbacks — no
// monkey-patching.  Ephemeral scopes become SQL transactions.
//
// Usage:
//   persist(engine, sqliteAdapter(db));
//   persist(engine, db);  // auto-detect better-sqlite3
//   persist(engine, adapter, null, {stringify: qjson_stringify, parse: qjson_parse});
//
// Adapter interface (6 methods):
//   setup, insert(key,functor,arity), remove(key), all(predicates), commit, close
// ============================================================

// ── Term serialization (inline, matches sync.js format) ─────

function _ser(t) {
  if (t.type === "atom") return { t: "a", n: t.name };
  if (t.type === "num") {
    var o = { t: "n", v: t.value };
    if (t.repr) o.r = t.repr;
    return o;
  }
  if (t.type === "compound") {
    var a = [];
    for (var i = 0; i < t.args.length; i++) a.push(_ser(t.args[i]));
    return { t: "c", f: t.functor, a: a };
  }
  return null;
}

function _deser(o) {
  if (o.t === "a") return { type: "atom", name: o.n };
  if (o.t === "n") {
    var t = { type: "num", value: o.v };
    if (o.r) t.repr = o.r;
    return t;
  }
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
    return db;
  }
  if (typeof db.prepare === "function" && typeof db.exec === "function") {
    var cache = {};
    function stmt(sql) {
      if (!cache[sql]) cache[sql] = db.prepare(sql);
      return cache[sql];
    }
    return {
      setup:  function() {
        db.exec("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY, functor TEXT, arity INTEGER)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_facts_pred ON facts(functor, arity)");
      },
      insert: function(key, functor, arity) { stmt("INSERT OR IGNORE INTO facts VALUES (?, ?, ?)").run(key, functor, arity); },
      remove: function(key) { stmt("DELETE FROM facts WHERE term = ?").run(key); },
      all:    function(predicates) {
        if (predicates) {
          var rows = [], keys = Object.keys(predicates);
          for (var i = 0; i < keys.length; i++) {
            var parts = keys[i].split("/");
            var matched = stmt("SELECT term FROM facts WHERE functor = ? AND arity = ?").all(parts[0], parseInt(parts[1], 10));
            for (var j = 0; j < matched.length; j++) rows.push(matched[j].term);
          }
          return rows;
        }
        return stmt("SELECT term FROM facts").all().map(function(r) { return r.term; });
      },
      commit: function() {},
      close:  function() { db.close(); }
    };
  }
  return db;
}

// ── Main function ───────────────────────────────────────────

function persist(engine, db, predicates, codec) {
  var adapter = _autoAdapter(db);

  var _dumps = (codec && codec.stringify) || JSON.stringify;
  var _codec_parse = codec && codec.parse;
  var _loads = _codec_parse
    ? function(text) { try { return JSON.parse(text); } catch(e) { return _codec_parse(text); } }
    : JSON.parse;

  function _key(term) { return _dumps(_ser(term)); }

  function _pred(term) {
    if (term.type === "compound") return [term.functor, term.args.length];
    if (term.type === "atom") return [term.name, 0];
    return [null, null];
  }

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

  // ── Restore ───────────────────────────────────────────
  adapter.setup();
  var keys = adapter.all(preds);
  for (var i = 0; i < keys.length; i++) {
    engine.addClause(_deser(_loads(keys[i])));
  }

  // ── Listen for assert → INSERT ────────────────────────
  engine.onAssert.push(function(head) {
    if (_ok(head)) {
      var p = _pred(head);
      adapter.insert(_key(head), p[0], p[1]);
      _commit();
    }
  });

  // ── Listen for retract → DELETE ───────────────────────
  engine.onRetract.push(function(head) {
    if (_ok(head)) {
      adapter.remove(_key(head));
      _commit();
    }
  });

  // ── Hook ephemeral/1 — transaction batching ───────────
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
