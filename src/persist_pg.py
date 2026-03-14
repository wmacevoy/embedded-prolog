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
    return {
        "setup": lambda: (
            conn.execute("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)"),
            conn.commit()
        ),
        "insert": lambda key: conn.execute(
            "INSERT INTO facts VALUES (%s) ON CONFLICT DO NOTHING", (key,)
        ),
        "remove": lambda key: conn.execute(
            "DELETE FROM facts WHERE term = %s", (key,)
        ),
        "all": lambda: [row[0] for row in conn.execute("SELECT term FROM facts")],
        "commit": lambda: conn.commit(),
        "close": lambda: conn.close(),
    }
