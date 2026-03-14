// ============================================================
// persist-pg.js — PostgreSQL adapter for persist
//
// Requires a synchronous PG driver (e.g. pg with sync queries,
// or pg-native).  The Prolog engine is synchronous — async PG
// drivers won't work in the hooks.
//
// Usage:
//   persist(engine, pgAdapter(pgClient));
// ============================================================

function pgAdapter(client) {
  return {
    setup: function() {
      client.query("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)");
    },
    insert: function(key) {
      client.query("INSERT INTO facts VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    },
    remove: function(key) {
      client.query("DELETE FROM facts WHERE term = $1", [key]);
    },
    all: function() {
      var result = client.query("SELECT term FROM facts");
      var rows = result.rows || result;
      var out = [];
      for (var i = 0; i < rows.length; i++) out.push(rows[i].term);
      return out;
    },
    commit: function() {},  // PG autocommits by default
    close: function() { client.end(); }
  };
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.pgAdapter = pgAdapter;
}
export { pgAdapter };
