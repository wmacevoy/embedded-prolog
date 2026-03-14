# ============================================================
# persist.py — One-function database persistence for Y@ Prolog
#
# Usage:
#   from prolog import Engine
#   from persist import persist
#
#   engine = Engine()
#   persist(engine, "state.db")           # SQLite shorthand
#   persist(engine, sqlite_adapter(path)) # explicit adapter
#   persist(engine, adapter, codec="qjson") # BigNum support
#
# Adapter interface (6 methods):
#   setup()       — create table if needed
#   insert(key)   — upsert fact (ignore duplicate)
#   remove(key)   — delete fact by key
#   all()         — return all fact keys as list of strings
#   commit()      — commit transaction
#   close()       — release connection
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


def _resolve_adapter(db):
    """Turn a db argument into an adapter.  Accepts:
    - str path       → sqlite_adapter(path)
    - dict w/ insert → already an adapter
    - DBAPI 2.0 conn → pg_adapter(conn)
    """
    if isinstance(db, str):
        from persist_sqlite import sqlite_adapter
        return sqlite_adapter(db)
    if isinstance(db, dict) and "insert" in db:
        return db
    from persist_pg import pg_adapter
    return pg_adapter(db)


def _resolve_codec(codec):
    """Return (dumps, loads) functions for the given codec."""
    if codec == "qjson":
        from qjson import stringify as _qs, parse as _qp
        def _loads(text):
            try:
                return json.loads(text)
            except (ValueError, TypeError):
                return _qp(text)
        return _qs, _loads
    if codec and not callable(codec):
        _cp = codec.get("parse")
        _cs = codec.get("stringify", lambda o: json.dumps(o, separators=(',', ':')))
        if _cp:
            def _loads(text):
                try:
                    return json.loads(text)
                except (ValueError, TypeError):
                    return _cp(text)
            return _cs, _loads
        return _cs, json.loads
    return lambda obj: json.dumps(obj, separators=(',', ':')), json.loads


def persist(engine, db, predicates=None, codec=None):
    """Attach database persistence to a Prolog engine.

    db         — file path (SQLite), adapter dict, or DBAPI 2.0 connection
    predicates — set of "functor/arity" to persist; None = all dynamic facts
    codec      — "qjson" for BigInt/BigDecimal/BigFloat, or None for plain JSON

    Returns the adapter.
    """
    adapter = _resolve_adapter(db)
    _dumps, _loads = _resolve_codec(codec)

    def _key(term):
        return _dumps(_ser(term))

    def _deser_row(text):
        return _deser(_loads(text))

    adapter["setup"]()

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
            adapter["commit"]()

    # ── Restore saved facts ──────────────────────────────────
    for text in adapter["all"]():
        engine.add_clause(_deser_row(text))

    # ── Hook assert/1 ────────────────────────────────────────
    orig_assert = engine.builtins["assert/1"]

    def _hooked_assert(goal, rest, subst, depth, on_sol):
        term = deep_walk(goal[2][0], subst)
        if _ok(term):
            adapter["insert"](_key(term))
            _commit()
        orig_assert(goal, rest, subst, depth, on_sol)

    engine.builtins["assert/1"] = _hooked_assert
    engine.builtins["assertz/1"] = _hooked_assert

    # ── Hook add_clause (covers programmatic additions) ──────
    _orig_add = engine.add_clause

    def _hooked_add_clause(head, body=None):
        _orig_add(head, body)
        if not body and _ok(head):
            adapter["insert"](_key(head))
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
                    adapter["remove"](_key(ch))
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
                    adapter["commit"]()

        engine.builtins["ephemeral/1"] = _hooked_ephemeral

    return adapter
