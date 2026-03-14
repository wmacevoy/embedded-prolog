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

    return {
        "setup": lambda: (
            conn.execute("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)"),
            conn.commit()
        ),
        "insert": lambda key: conn.execute(
            "INSERT OR IGNORE INTO facts VALUES (?)", (key,)
        ),
        "remove": lambda key: conn.execute(
            "DELETE FROM facts WHERE term = ?", (key,)
        ),
        "all": lambda: [row[0] for row in conn.execute("SELECT term FROM facts")],
        "commit": lambda: conn.commit(),
        "close": lambda: conn.close(),
    }
