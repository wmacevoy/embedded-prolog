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

    return {
        "setup": lambda: (
            conn.execute("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)"),
            conn.commit()
        ),
        "insert": lambda k: conn.execute(
            "INSERT OR IGNORE INTO facts VALUES (?)", (k,)
        ),
        "remove": lambda k: conn.execute(
            "DELETE FROM facts WHERE term = ?", (k,)
        ),
        "all": lambda: [row[0] for row in conn.execute("SELECT term FROM facts")],
        "commit": lambda: conn.commit(),
        "close": lambda: conn.close(),
    }
