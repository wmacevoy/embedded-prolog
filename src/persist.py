# ============================================================
# persist.py — One-function database persistence for Y@ Prolog
#
# Usage:
#   from prolog import Engine
#   from persist import persist
#
#   engine = Engine()
#   db = persist(engine, "state.db")
#   # assert/retract are now durable — facts survive restart
#
# Pass a file path for SQLite, or a DBAPI 2.0 connection for PG:
#   db = persist(engine, pg_conn)
#
# If using ephemeral/react, call persist() AFTER registering
# ephemeral/1.  Ephemeral scopes become SQL transactions —
# all mutations inside one signal handler commit atomically.
# ============================================================

import json
from prolog import deep_walk, unify


def _ser(term):
    if term[0] == "atom":     return {"t": "a", "n": term[1]}
    if term[0] == "num":      return {"t": "n", "v": term[1]}
    if term[0] == "compound":
        return {"t": "c", "f": term[1], "a": [_ser(a) for a in term[2]]}
    return None


def _deser(obj):
    if obj["t"] == "a": return ("atom", obj["n"])
    if obj["t"] == "n": return ("num", obj["v"])
    if obj["t"] == "c":
        return ("compound", obj["f"], tuple(_deser(a) for a in obj["a"]))
    return None


def persist(engine, db, predicates=None, codec=None):
    """Attach database persistence to a Prolog engine.

    db         — file path (SQLite) or DBAPI 2.0 connection (PostgreSQL)
    predicates — set of "functor/arity" to persist; None = all dynamic facts
    codec      — "qjson" for BigInt/BigDecimal support, or None for plain JSON

    Returns the database connection.
    """
    if codec == "qjson":
        from qjson import stringify as _qjson_dumps, parse as _qjson_parse
        _dumps = _qjson_dumps
        def _loads(text):
            try:
                return json.loads(text)
            except (ValueError, TypeError):
                return _qjson_parse(text)
    elif codec and not callable(codec):
        _codec_parse = codec.get("parse")
        _dumps = codec.get("stringify", lambda o: json.dumps(o, separators=(',', ':')))
        if _codec_parse:
            def _loads(text):
                try:
                    return json.loads(text)
                except (ValueError, TypeError):
                    return _codec_parse(text)
        else:
            _loads = json.loads
    else:
        _dumps = lambda obj: json.dumps(obj, separators=(',', ':'))
        _loads = json.loads

    def _key(term):
        return _dumps(_ser(term))

    def _deser_row(text):
        return _deser(_loads(text))
    if isinstance(db, str):
        import sqlite3
        conn = sqlite3.connect(db)
        conn.execute("PRAGMA journal_mode=WAL")
        ins_sql = "INSERT OR IGNORE INTO facts VALUES (?)"
        del_sql = "DELETE FROM facts WHERE term = ?"
    else:
        conn = db
        ins_sql = "INSERT INTO facts VALUES (%s) ON CONFLICT DO NOTHING"
        del_sql = "DELETE FROM facts WHERE term = %s"

    conn.execute("CREATE TABLE IF NOT EXISTS facts (term TEXT PRIMARY KEY)")
    conn.commit()

    _txn = [0]  # ephemeral transaction depth

    def _ok(term):
        if predicates is None:
            return True
        if term[0] == "compound":
            return term[1] + "/" + str(len(term[2])) in predicates
        if term[0] == "atom":
            return term[1] + "/0" in predicates
        return False

    def _commit():
        if _txn[0] == 0:
            conn.commit()

    # ── Restore saved facts ──────────────────────────────────
    for row in conn.execute("SELECT term FROM facts"):
        engine.add_clause(_deser_row(row[0]))

    # ── Hook assert/1 ────────────────────────────────────────
    orig_assert = engine.builtins["assert/1"]

    def _hooked_assert(goal, rest, subst, depth, on_sol):
        term = deep_walk(goal[2][0], subst)
        if _ok(term):
            conn.execute(ins_sql, (_key(term),))
            _commit()
        orig_assert(goal, rest, subst, depth, on_sol)

    engine.builtins["assert/1"] = _hooked_assert
    engine.builtins["assertz/1"] = _hooked_assert

    # ── Hook add_clause (covers programmatic additions) ──────
    _orig_add = engine.add_clause

    def _hooked_add_clause(head, body=None):
        _orig_add(head, body)
        if not body and _ok(head):
            conn.execute(ins_sql, (_key(head),))
            _commit()

    engine.add_clause = _hooked_add_clause

    # ── Hook retract_first (covers retract/1 + retractall/1) ─
    def _hooked_retract_first(head):
        for i in range(len(engine.clauses)):
            ch, cb = engine.clauses[i]
            s = unify(head, ch, {})
            if s is not None:
                engine.clauses.pop(i)
                if not cb and _ok(ch):
                    conn.execute(del_sql, (_key(ch),))
                    _commit()
                return True
        return False

    engine.retract_first = _hooked_retract_first

    # ── Hook ephemeral/1 — ephemeral scope = SQL transaction ─
    if "ephemeral/1" in engine.builtins:
        _orig_eph = engine.builtins["ephemeral/1"]

        def _hooked_ephemeral(goal, rest, subst, depth, on_sol):
            _txn[0] += 1
            try:
                _orig_eph(goal, rest, subst, depth, on_sol)
            finally:
                _txn[0] -= 1
                if _txn[0] == 0:
                    conn.commit()

        engine.builtins["ephemeral/1"] = _hooked_ephemeral

    return conn
