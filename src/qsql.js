// ============================================================
// qsql.js — QSQL: Per-predicate typed SQLite adapter for persist
//
// Zero-impedance bridge: Prolog terms → per-predicate SQLite
// tables with typed argument columns.
//
//   price(aapl, 187.68)  →  table "q$price$2"
//                             _key TEXT PRIMARY KEY
//                             arg0 TEXT   = 'aapl'
//                             arg1 REAL   = 187.68
//
// Atoms → TEXT, numbers → REAL/INTEGER, compounds → JSON TEXT.
// SQLite can index and range-scan individual arguments.
//
// Drop-in replacement for persist-sqlite.js:
//   persist(engine, qsqlAdapter(db));
//
// With QJSON codec for BigNum preservation:
//   persist(engine, qsqlAdapter(db, { parse: qjson_parse }));
//
// Adapter interface:
//   setup, insert(key,functor,arity), remove(key), all(predicates),
//   commit, close
//
// Portable: ES5 style (var, function, no arrows).
// ============================================================

// ── Helpers ──────────────────────────────────────────────────

// Sanitize functor name for use in SQL identifiers
function _qsql_safeName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// Table name for a predicate: q$functor$arity
function _qsql_tableName(functor, arity) {
  return "q$" + _qsql_safeName(functor) + "$" + arity;
}

// Convert a serialized term arg to a native SQLite value
//   atom   → TEXT (the name)
//   num    → REAL/INTEGER (or TEXT for BigInt/BigDecimal/BigFloat)
//   other  → JSON TEXT
function _qsql_argVal(arg) {
  if (!arg) return null;
  if (arg.t === "a") return arg.n;
  if (arg.t === "n") {
    var v = arg.v;
    if (typeof v === "number") return v;
    return String(v);
  }
  return JSON.stringify(arg);
}

// Extract the QJSON repr from a serialized num arg (if present)
function _qsql_argRepr(arg) {
  if (!arg || arg.t !== "n") return null;
  return arg.r || null;
}

// ── Adapter Factory ──────────────────────────────────────────

function qsqlAdapter(db, options) {
  var _parse = (options && options.parse) || JSON.parse;
  var _known = {};    // "functor/arity" → true
  var _cache = {};    // sql string → prepared statement

  function _stmt(sql) {
    if (!_cache[sql]) _cache[sql] = db.prepare(sql);
    return _cache[sql];
  }

  function _ensureTable(functor, arity) {
    var fa = functor + "/" + arity;
    if (_known[fa]) return;

    var tbl = _qsql_tableName(functor, arity);
    var ddl = 'CREATE TABLE IF NOT EXISTS "' + tbl + '" (_key TEXT PRIMARY KEY';
    for (var i = 0; i < arity; i++) ddl += ", arg" + i;
    ddl += ")";
    db.exec(ddl);

    for (var i = 0; i < arity; i++) {
      db.exec('CREATE INDEX IF NOT EXISTS "ix$' + tbl + '$' + i +
              '" ON "' + tbl + '"(arg' + i + ')');
    }

    _stmt("INSERT OR IGNORE INTO qsql_meta VALUES (?, ?)").run(functor, arity);
    _known[fa] = true;
  }

  return {
    setup: function() {
      db.exec(
        "CREATE TABLE IF NOT EXISTS qsql_meta " +
        "(functor TEXT, arity INTEGER, PRIMARY KEY(functor, arity))"
      );
      var metas = _stmt("SELECT functor, arity FROM qsql_meta").all();
      for (var i = 0; i < metas.length; i++) {
        _known[metas[i].functor + "/" + metas[i].arity] = true;
      }
    },

    insert: function(key, functor, arity) {
      if (functor == null) return;
      _ensureTable(functor, arity);

      var obj = _parse(key);
      var values = [key];
      if (obj.t === "c" && obj.a) {
        for (var i = 0; i < arity; i++) {
          values.push(i < obj.a.length ? _qsql_argVal(obj.a[i]) : null);
        }
      }

      var tbl = _qsql_tableName(functor, arity);
      var ph = "?";
      for (var i = 1; i < values.length; i++) ph += ", ?";
      var sql = 'INSERT OR IGNORE INTO "' + tbl + '" VALUES (' + ph + ')';
      var s = _stmt(sql);
      s.run.apply(s, values);
    },

    remove: function(key) {
      var obj;
      try { obj = _parse(key); } catch(e) { return; }
      var functor, arity;
      if (obj.t === "c") { functor = obj.f; arity = (obj.a || []).length; }
      else if (obj.t === "a") { functor = obj.n; arity = 0; }
      else return;

      var fa = functor + "/" + arity;
      if (!_known[fa]) return;
      var tbl = _qsql_tableName(functor, arity);
      _stmt('DELETE FROM "' + tbl + '" WHERE _key = ?').run(key);
    },

    all: function(predicates) {
      var results = [];
      var metas;
      if (predicates) {
        metas = [];
        var keys = Object.keys(predicates);
        for (var i = 0; i < keys.length; i++) {
          var parts = keys[i].split("/");
          metas.push({ functor: parts[0], arity: parseInt(parts[1], 10) });
        }
      } else {
        metas = _stmt("SELECT functor, arity FROM qsql_meta").all();
      }
      for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        if (!_known[m.functor + "/" + m.arity]) continue;
        var tbl = _qsql_tableName(m.functor, m.arity);
        try {
          var rows = _stmt('SELECT _key FROM "' + tbl + '"').all();
          for (var j = 0; j < rows.length; j++) {
            results.push(rows[j]._key);
          }
        } catch(e) { /* table might not exist yet */ }
      }
      return results;
    },

    commit: function() {},

    close: function() {
      _cache = {};
      if (db.close) db.close();
    }
  };
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.qsqlAdapter = qsqlAdapter;
  exports._qsql_tableName = _qsql_tableName;
  exports._qsql_argVal = _qsql_argVal;
  exports._qsql_safeName = _qsql_safeName;
}
export { qsqlAdapter, _qsql_tableName, _qsql_argVal, _qsql_safeName };
