# ============================================================
# persist_pg.py — PostgreSQL adapter for persist
#
# Works with any DBAPI 2.0 connection (psycopg2, psycopg3, etc.)
#
# Usage:
#   import psycopg2
#   from persist_pg import pg_adapter
#   persist(engine, pg_adapter(psycopg2.connect("dbname=app")))
# ============================================================


def pg_adapter(conn):
    """Create a PostgreSQL persist adapter.

    conn — DBAPI 2.0 connection (psycopg2, psycopg3, etc.)
    """
    def _setup():
        conn.execute(
            "CREATE TABLE IF NOT EXISTS facts "
            "(term TEXT PRIMARY KEY, functor TEXT, arity INTEGER)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_facts_pred ON facts(functor, arity)"
        )
        conn.commit()

    def _all(predicates=None):
        if predicates:
            rows = []
            for pred in predicates:
                parts = pred.split("/")
                cur = conn.execute(
                    "SELECT term FROM facts WHERE functor = %s AND arity = %s",
                    (parts[0], int(parts[1]))
                )
                rows.extend(cur.fetchall())
            return [r[0] for r in rows]
        return [r[0] for r in conn.execute("SELECT term FROM facts")]

    return {
        "setup":  _setup,
        "insert": lambda key, functor=None, arity=None: conn.execute(
            "INSERT INTO facts VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (key, functor, arity)
        ),
        "remove": lambda key: conn.execute(
            "DELETE FROM facts WHERE term = %s", (key,)
        ),
        "all":    _all,
        "commit": lambda: conn.commit(),
        "close":  lambda: conn.close(),
    }
