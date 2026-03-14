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
# Uses engine.on_assert / engine.on_retract callbacks — no
# monkey-patching.  Ephemeral scopes become SQL transactions.
# ============================================================

import json
from prolog import deep_walk, unify


def _ser(term):
    if term[0] == "atom":     return {"t": "a", "n": term[1]}
    if term[0] == "num":
        o = {"t": "n", "v": term[1]}
        if len(term) > 2 and term[2]:
            o["r"] = term[2]
        return o
    if term[0] == "compound":
        return {"t": "c", "f": term[1], "a": [_ser(a) for a in term[2]]}
    return None


def _deser(obj):
    if obj["t"] == "a": return ("atom", obj["n"])
    if obj["t"] == "n":
        if "r" in obj:
            return ("num", obj["v"], obj["r"])
        return ("num", obj["v"])
    if obj["t"] == "c":
        return ("compound", obj["f"], tuple(_deser(a) for a in obj["a"]))
    return None


def _resolve_adapter(db):
    if isinstance(db, str):
        from persist_sqlite import sqlite_adapter
        return sqlite_adapter(db)
    if isinstance(db, dict) and "insert" in db:
        return db
    from persist_pg import pg_adapter
    return pg_adapter(db)


def _resolve_codec(codec):
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

    def _pred(term):
        if term[0] == "compound":
            return term[1], len(term[2])
        if term[0] == "atom":
            return term[1], 0
        return None, None

    def _ok(term):
        if predicates is None:
            return True
        if term[0] == "compound":
            return term[1] + "/" + str(len(term[2])) in predicates
        if term[0] == "atom":
            return term[1] + "/0" in predicates
        return False

    _txn = [0]

    def _commit():
        if _txn[0] == 0:
            adapter["commit"]()

    # ── Restore saved facts ──────────────────────────────────
    adapter["setup"]()
    for text in adapter["all"](predicates):
        engine.add_clause(_deser(_loads(text)))

    # ── Listen for assert → INSERT ───────────────────────────
    def _on_assert(head):
        if _ok(head):
            f, a = _pred(head)
            adapter["insert"](_key(head), f, a)
            _commit()

    engine.on_assert.append(_on_assert)

    # ── Listen for retract → DELETE ──────────────────────────
    def _on_retract(head):
        if _ok(head):
            adapter["remove"](_key(head))
            _commit()

    engine.on_retract.append(_on_retract)

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
