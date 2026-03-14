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
      db.exec("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)");
    },
    insert: function(key) {
      stmt("INSERT OR IGNORE INTO facts VALUES (?)").run(key);
    },
    remove: function(key) {
      stmt("DELETE FROM facts WHERE term = ?").run(key);
    },
    all: function() {
      return stmt("SELECT term FROM facts").all().map(function(r) { return r.term; });
    },
    commit: function() {},  // better-sqlite3 / bun:sqlite are autocommit
    close: function() { db.close(); }
  };
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.sqliteAdapter = sqliteAdapter;
}
export { sqliteAdapter };
