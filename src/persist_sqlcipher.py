# ============================================================
# persist_sqlcipher.py — SQLCipher adapter for persist
#
# Encrypted SQLite.  Same API as sqlite_adapter, plus PRAGMA key.
# Requires pysqlcipher3 or sqlcipher3:
#   pip install pysqlcipher3
#
# Usage:
#   from persist_sqlcipher import sqlcipher_adapter
#   persist(engine, sqlcipher_adapter("state.db", "secret"))
# ============================================================


def sqlcipher_adapter(path, key):
    """Create a SQLCipher persist adapter.

    path — file path (created if missing)
    key  — encryption passphrase
    """
    try:
        from pysqlcipher3 import dbapi2 as db_mod
    except ImportError:
        import sqlcipher3 as db_mod

    conn = db_mod.connect(path)
    conn.execute("PRAGMA key = ?", (key,))
    conn.execute("PRAGMA journal_mode=WAL")

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
                rows.extend(conn.execute(
                    "SELECT term FROM facts WHERE functor = ? AND arity = ?",
                    (parts[0], int(parts[1]))
                ).fetchall())
            return [r[0] for r in rows]
        return [r[0] for r in conn.execute("SELECT term FROM facts")]

    return {
        "setup":  _setup,
        "insert": lambda key, functor=None, arity=None: conn.execute(
            "INSERT OR IGNORE INTO facts VALUES (?, ?, ?)", (key, functor, arity)
        ),
        "remove": lambda key: conn.execute(
            "DELETE FROM facts WHERE term = ?", (key,)
        ),
        "all":    _all,
        "commit": lambda: conn.commit(),
        "close":  lambda: conn.close(),
    }
