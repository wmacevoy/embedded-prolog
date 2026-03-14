// ============================================================
// persist-sqlite.js — SQLite adapter for persist
//
// Usage with better-sqlite3:
//   var Database = require('better-sqlite3');
//   persist(engine, sqliteAdapter(new Database('state.db')));
//
// Or with bun:sqlite:
//   var { Database } = require('bun:sqlite');
//   persist(engine, sqliteAdapter(new Database('state.db')));
//
// Or just:  persist(engine, db)  — auto-detected if db has .prepare
// ============================================================

function sqliteAdapter(db) {
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
  exports.sqliteAdapter = sqliteAdapter;
}
export { sqliteAdapter };
