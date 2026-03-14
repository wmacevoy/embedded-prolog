# ============================================================
# persist_sqlite.py — SQLite adapter for persist
#
# Usage:
#   from persist_sqlite import sqlite_adapter
#   from persist import persist
#   persist(engine, sqlite_adapter("state.db"))
#
# Or just:  persist(engine, "state.db")  — auto-detected
# ============================================================


def sqlite_adapter(path):
    """Create a SQLite persist adapter.

    path — file path or ":memory:"
    """
    import sqlite3
    conn = sqlite3.connect(path)
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
