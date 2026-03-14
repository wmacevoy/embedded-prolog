// ============================================================
// persist-sqlcipher.js — SQLCipher adapter for persist
//
// Encrypted SQLite.  Same as sqliteAdapter + PRAGMA key.
// Requires better-sqlite3 compiled with SQLCipher support,
// or @journeyapps/sqlcipher.
//
// Usage:
//   persist(engine, sqlcipherAdapter(new Database('state.db'), 'secret'));
// ============================================================

function sqlcipherAdapter(db, key) {
  db.pragma("key = '" + key + "'");

  var cache = {};
  function stmt(sql) {
    if (!cache[sql]) cache[sql] = db.prepare(sql);
    return cache[sql];
  }

  return {
    setup: function() {
      db.exec(
        "CREATE TABLE IF NOT EXISTS facts " +
        "(term TEXT PRIMARY KEY, functor TEXT, arity INTEGER)"
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_facts_pred ON facts(functor, arity)"
      );
    },
    insert: function(key, functor, arity) {
      stmt("INSERT OR IGNORE INTO facts VALUES (?, ?, ?)").run(key, functor, arity);
    },
    remove: function(key) {
      stmt("DELETE FROM facts WHERE term = ?").run(key);
    },
    all: function(predicates) {
      if (predicates) {
        var rows = [], keys = Object.keys(predicates);
        for (var i = 0; i < keys.length; i++) {
          var parts = keys[i].split("/");
          var matched = stmt("SELECT term FROM facts WHERE functor = ? AND arity = ?")
            .all(parts[0], parseInt(parts[1], 10));
          for (var j = 0; j < matched.length; j++) rows.push(matched[j].term);
        }
        return rows;
      }
      return stmt("SELECT term FROM facts").all().map(function(r) { return r.term; });
    },
    commit: function() {},
    close: function() { db.close(); }
  };
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.sqlcipherAdapter = sqlcipherAdapter;
}
export { sqlcipherAdapter };
