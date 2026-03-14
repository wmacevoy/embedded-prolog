# ============================================================
# fossilize.py — Freeze a Prolog engine's clause database
# mineralize.py — Selectively lock specific predicates
#
# Two modes of hardening:
#
#   mineralize(engine, "react", 0)
#     → react/0 is immutable.  Everything else stays dynamic.
#
#   fossilize(engine)
#     → ALL clauses frozen.  Only ephemeral survives.
# ============================================================

from prolog import unify


def _pred_key(term):
    if term is None:
        return None
    if term[0] == "compound":
        return "%s/%d" % (term[1], len(term[2]))
    if term[0] == "atom":
        return "%s/0" % term[1]
    return None


# ── mineralize ───────────────────────────────────────────────

def mineralize(engine, functor, arity):
    """Lock a specific predicate. One-way, additive."""
    if not hasattr(engine, 'mineralized'):
        engine.mineralized = {}
        _install_mineralize_guards(engine)
    engine.mineralized["%s/%d" % (functor, arity)] = True


def _install_mineralize_guards(engine):
    # Guard add_clause
    orig_add = engine.add_clause

    def _guarded_add(head, body=None):
        key = _pred_key(head)
        if key and key in engine.mineralized:
            return
        orig_add(head, body)

    engine.add_clause = _guarded_add

    # Guard retract_first
    orig_retract = engine.retract_first

    def _guarded_retract(head):
        key = _pred_key(head)
        if key and key in engine.mineralized:
            return False
        return orig_retract(head)

    engine.retract_first = _guarded_retract

    # Guard assert/1
    orig_assert = engine.builtins.get("assert/1")
    if orig_assert:
        def _guarded_assert_builtin(goal, rest, subst, depth, on_sol):
            from prolog import deep_walk
            term = deep_walk(goal[2][0], subst)
            key = _pred_key(term)
            if key and key in engine.mineralized:
                return
            orig_assert(goal, rest, subst, depth, on_sol)
        engine.builtins["assert/1"] = _guarded_assert_builtin

    # Guard assertz/1
    orig_assertz = engine.builtins.get("assertz/1")
    if orig_assertz:
        def _guarded_assertz(goal, rest, subst, depth, on_sol):
            from prolog import deep_walk
            term = deep_walk(goal[2][0], subst)
            key = _pred_key(term)
            if key and key in engine.mineralized:
                return
            orig_assertz(goal, rest, subst, depth, on_sol)
        engine.builtins["assertz/1"] = _guarded_assertz

    # Guard retract/1
    orig_retract_b = engine.builtins.get("retract/1")
    if orig_retract_b:
        def _guarded_retract_builtin(goal, rest, subst, depth, on_sol):
            from prolog import deep_walk
            term = deep_walk(goal[2][0], subst)
            key = _pred_key(term)
            if key and key in engine.mineralized:
                return
            orig_retract_b(goal, rest, subst, depth, on_sol)
        engine.builtins["retract/1"] = _guarded_retract_builtin

    # Guard retractall/1
    orig_retractall = engine.builtins.get("retractall/1")
    if orig_retractall:
        def _guarded_retractall(goal, rest, subst, depth, on_sol):
            from prolog import deep_walk
            term = deep_walk(goal[2][0], subst)
            key = _pred_key(term)
            if key and key in engine.mineralized:
                return
            orig_retractall(goal, rest, subst, depth, on_sol)
        engine.builtins["retractall/1"] = _guarded_retractall

    # Guard ephemeral/1
    orig_eph = engine.builtins.get("ephemeral/1")
    if orig_eph:
        def _guarded_eph(goal, rest, subst, depth, on_sol):
            from prolog import deep_walk
            term = deep_walk(goal[2][0], subst)
            key = _pred_key(term)
            if key and key in engine.mineralized:
                return
            orig_eph(goal, rest, subst, depth, on_sol)
        engine.builtins["ephemeral/1"] = _guarded_eph

    # mineralize/1 builtin — callable from Prolog
    def _mineralize_builtin(goal, rest, subst, depth, on_sol):
        from prolog import deep_walk
        term = deep_walk(goal[2][0], subst)
        if (term[0] == "compound" and term[1] == "/" and len(term[2]) == 2):
            f = term[2][0]
            a = term[2][1]
            if f[0] == "atom" and a[0] == "num":
                engine.mineralized["%s/%d" % (f[1], a[1])] = True
        engine._solve(rest, subst, depth + 1, on_sol)

    engine.builtins["mineralize/1"] = _mineralize_builtin


# ── fossilize ────────────────────────────────────────────────

def fossilize(engine):
    """Freeze the clause database.  Only ephemeral facts allowed after this."""
    boundary = len(engine.clauses)

    def _fail(*args):
        pass

    engine.builtins["assert/1"] = _fail
    engine.builtins["assertz/1"] = _fail
    engine.builtins["retract/1"] = _fail
    engine.builtins["retractall/1"] = _fail

    engine.add_clause = lambda head, body=None: None

    def _fossil_retract_first(head):
        for i in range(boundary, len(engine.clauses)):
            ch, cb = engine.clauses[i]
            s = unify(head, ch, {})
            if s is not None:
                engine.clauses.pop(i)
                if not cb:
                    for fn in engine.on_retract:
                        fn(ch)
                return True
        return False

    engine.retract_first = _fossil_retract_first

    return boundary
