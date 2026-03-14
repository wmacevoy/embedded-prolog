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
      client.query(
        "CREATE TABLE IF NOT EXISTS facts " +
        "(term TEXT PRIMARY KEY, functor TEXT, arity INTEGER)"
      );
      client.query(
        "CREATE INDEX IF NOT EXISTS idx_facts_pred ON facts(functor, arity)"
      );
    },
    insert: function(key, functor, arity) {
      client.query(
        "INSERT INTO facts VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [key, functor, arity]
      );
    },
    remove: function(key) {
      client.query("DELETE FROM facts WHERE term = $1", [key]);
    },
    all: function(predicates) {
      if (predicates) {
        var out = [], keys = Object.keys(predicates);
        for (var i = 0; i < keys.length; i++) {
          var parts = keys[i].split("/");
          var result = client.query(
            "SELECT term FROM facts WHERE functor = $1 AND arity = $2",
            [parts[0], parseInt(parts[1], 10)]
          );
          var rows = result.rows || result;
          for (var j = 0; j < rows.length; j++) out.push(rows[j].term);
        }
        return out;
      }
      var result = client.query("SELECT term FROM facts");
      var rows = result.rows || result;
      var out = [];
      for (var i = 0; i < rows.length; i++) out.push(rows[i].term);
      return out;
    },
    commit: function() {},
    close: function() { client.end(); }
  };
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.pgAdapter = pgAdapter;
}
export { pgAdapter };
