# ============================================================
# qsql.py — QSQL: Per-predicate typed SQLite adapter for persist
#
# Zero-impedance bridge: Prolog terms → per-predicate SQLite
# tables with typed argument columns.
#
#   price(aapl, 187.68)  →  table "q$price$2"
#                             _key TEXT PRIMARY KEY
#                             arg0 TEXT   = 'aapl'
#                             arg1 REAL   = 187.68
#
# Atoms → TEXT, numbers → REAL/INTEGER, compounds → JSON TEXT.
# SQLite can index and range-scan individual arguments.
#
# Usage:
#   from qsql import qsql_adapter
#   from persist import persist
#   persist(engine, qsql_adapter("state.db"))
#   persist(engine, qsql_adapter(":memory:"))
# ============================================================

import json
import re


def _safe_name(name):
    return re.sub(r'[^a-zA-Z0-9_]', '_', name)


def _table_name(functor, arity):
    return "q$%s$%d" % (_safe_name(functor), arity)


def _arg_val(arg):
    """Convert a serialized term arg to a native SQLite value."""
    if arg is None:
        return None
    t = arg.get("t")
    if t == "a":
        return arg["n"]
    if t == "n":
        v = arg["v"]
        if isinstance(v, (int, float)):
            return v
        return str(v)  # Decimal, BigFloat → TEXT
    return json.dumps(arg, separators=(',', ':'))


def qsql_adapter(path, parse_fn=None):
    """Create a QSQL adapter for per-predicate typed SQLite storage.

    path      — file path or ":memory:"
    parse_fn  — optional QJSON parse function (default: json.loads)
    """
    import sqlite3
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")

    _parse = parse_fn or json.loads
    _known = {}  # "functor/arity" → True

    def _ensure_table(functor, arity):
        fa = "%s/%d" % (functor, arity)
        if fa in _known:
            return
        tbl = _table_name(functor, arity)
        cols = ", ".join("arg%d" % i for i in range(arity))
        ddl = 'CREATE TABLE IF NOT EXISTS "%s" (_key TEXT PRIMARY KEY%s)' % (
            tbl, (", " + cols) if cols else "")
        conn.execute(ddl)
        for i in range(arity):
            conn.execute(
                'CREATE INDEX IF NOT EXISTS "ix$%s$%d" ON "%s"(arg%d)' %
                (tbl, i, tbl, i))
        conn.execute(
            "INSERT OR IGNORE INTO qsql_meta VALUES (?, ?)",
            (functor, arity))
        conn.commit()
        _known[fa] = True

    def _setup():
        conn.execute(
            "CREATE TABLE IF NOT EXISTS qsql_meta "
            "(functor TEXT, arity INTEGER, PRIMARY KEY(functor, arity))")
        conn.commit()
        for row in conn.execute("SELECT functor, arity FROM qsql_meta"):
            _known["%s/%d" % (row[0], row[1])] = True

    def _insert(key, functor=None, arity=None):
        if functor is None:
            return
        _ensure_table(functor, arity)
        obj = _parse(key)
        values = [key]
        if obj.get("t") == "c" and "a" in obj:
            for i in range(arity):
                if i < len(obj["a"]):
                    values.append(_arg_val(obj["a"][i]))
                else:
                    values.append(None)
        tbl = _table_name(functor, arity)
        ph = ", ".join("?" for _ in values)
        conn.execute(
            'INSERT OR IGNORE INTO "%s" VALUES (%s)' % (tbl, ph),
            tuple(values))

    def _remove(key):
        try:
            obj = _parse(key)
        except (ValueError, TypeError):
            return
        if obj.get("t") == "c":
            functor = obj["f"]
            arity = len(obj.get("a", []))
        elif obj.get("t") == "a":
            functor = obj["n"]
            arity = 0
        else:
            return
        fa = "%s/%d" % (functor, arity)
        if fa not in _known:
            return
        tbl = _table_name(functor, arity)
        conn.execute('DELETE FROM "%s" WHERE _key = ?' % tbl, (key,))

    def _all(predicates=None):
        results = []
        if predicates:
            metas = []
            for pred in predicates:
                parts = pred.split("/")
                metas.append((parts[0], int(parts[1])))
        else:
            metas = conn.execute(
                "SELECT functor, arity FROM qsql_meta").fetchall()
        for functor, arity in metas:
            fa = "%s/%d" % (functor, arity)
            if fa not in _known:
                continue
            tbl = _table_name(functor, arity)
            try:
                rows = conn.execute(
                    'SELECT _key FROM "%s"' % tbl).fetchall()
                for row in rows:
                    results.append(row[0])
            except Exception:
                pass
        return results

    return {
        "setup": _setup,
        "insert": _insert,
        "remove": _remove,
        "all": _all,
        "commit": lambda: conn.commit(),
        "close": lambda: conn.close(),
    }
