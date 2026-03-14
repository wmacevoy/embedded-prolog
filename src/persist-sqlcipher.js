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
      db.exec("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)");
    },
    insert: function(k) {
      stmt("INSERT OR IGNORE INTO facts VALUES (?)").run(k);
    },
    remove: function(k) {
      stmt("DELETE FROM facts WHERE term = ?").run(k);
    },
    all: function() {
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
