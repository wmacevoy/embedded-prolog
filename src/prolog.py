# ============================================================
# prolog.py — Mini Prolog interpreter in pure Python
#
# Runs on CPython 3.7+ and MicroPython 1.20+.
# No dependencies.  No C extension required.
#
# The C-accelerated version (prolog_native) is a drop-in
# replacement when you need speed — same API, same results.
#
# Usage:
#   from prolog import Engine, atom, var, compound, num, lst
#   e = Engine()
#   e.add_clause(compound("parent", [atom("tom"), atom("bob")]))
#   results = e.query(compound("parent", [atom("tom"), var("X")]))
# ============================================================


# ── Term representation ──────────────────────────────────────
# Terms are plain tuples for minimal allocation:
#   ("atom", name)
#   ("var", name)
#   ("num", value)
#   ("compound", functor, (arg0, arg1, ...))

def atom(name):
    return ("atom", name)

def var(name):
    return ("var", name)

def compound(functor, args):
    return ("compound", functor, tuple(args))

def num(n):
    return ("num", n)

def lst(items, tail=None):
    """Build a Prolog list from a Python list."""
    result = tail if tail else atom("[]")
    i = len(items) - 1
    while i >= 0:
        result = compound(".", [items[i], result])
        i -= 1
    return result

NIL = atom("[]")


# ── Substitution ─────────────────────────────────────────────
# A dict mapping variable names to terms.

def walk(term, subst):
    while term[0] == "var" and term[1] in subst:
        term = subst[term[1]]
    return term

def deep_walk(term, subst):
    term = walk(term, subst)
    if term[0] == "compound":
        args = tuple(deep_walk(a, subst) for a in term[2])
        return (term[0], term[1], args)
    return term


# ── Unification ──────────────────────────────────────────────

def unify(a, b, subst):
    a = walk(a, subst)
    b = walk(b, subst)
    if a[0] == "var":
        s = dict(subst)
        s[a[1]] = b
        return s
    if b[0] == "var":
        s = dict(subst)
        s[b[1]] = a
        return s
    if a[0] == "atom" and b[0] == "atom" and a[1] == b[1]:
        return subst
    if a[0] == "num" and b[0] == "num" and a[1] == b[1]:
        return subst
    if (a[0] == "compound" and b[0] == "compound" and
        a[1] == b[1] and len(a[2]) == len(b[2])):
        s = subst
        for i in range(len(a[2])):
            s = unify(a[2][i], b[2][i], s)
            if s is None:
                return None
        return s
    return None


# ── Engine ───────────────────────────────────────────────────

class _Found(Exception):
    """Sentinel for first-solution early exit."""
    __slots__ = ("result",)
    def __init__(self, result):
        self.result = result

class Engine:
    def __init__(self):
        self.clauses = []
        self.builtins = {}
        self._var_counter = 0
        self._register_builtins()

    # ── Clause management ────────────────────────────────────

    def add_clause(self, head, body=None):
        self.clauses.append((head, body or []))

    def retract_first(self, head):
        for i in range(len(self.clauses)):
            s = unify(head, self._fresh(self.clauses[i][0]), {})
            if s is not None:
                self.clauses.pop(i)
                return True
        return False

    def _fresh(self, term):
        """Rename variables to fresh names."""
        self._var_counter += 1
        base = self._var_counter * 1000
        return self._rename(term, {}, base)

    def _rename(self, term, mapping, base):
        if term[0] == "var":
            if term[1] not in mapping:
                mapping[term[1]] = var("_R" + str(base + len(mapping)))
            return mapping[term[1]]
        if term[0] == "compound":
            args = tuple(self._rename(a, mapping, base) for a in term[2])
            return (term[0], term[1], args)
        return term

    def _fresh_clause(self, clause):
        self._var_counter += 1
        base = self._var_counter * 1000
        mapping = {}
        head = self._rename(clause[0], mapping, base)
        body = [self._rename(g, mapping, base) for g in clause[1]]
        return (head, body)

    # ── Solver ───────────────────────────────────────────────

    def _solve(self, goals, subst, depth, on_solution):
        if depth > 300:
            return
        if not goals:
            on_solution(subst)
            return

        goal = deep_walk(goals[0], subst)
        rest = goals[1:]

        # Check builtins
        if goal[0] == "compound":
            key = goal[1] + "/" + str(len(goal[2]))
        elif goal[0] == "atom":
            key = goal[1] + "/0"
        else:
            key = None

        if key and key in self.builtins:
            self.builtins[key](goal, rest, subst, depth, on_solution)
            return

        # Try each clause
        for clause in self.clauses:
            fresh_head, fresh_body = self._fresh_clause(clause)
            s = unify(goal, fresh_head, subst)
            if s is not None:
                self._solve(fresh_body + rest, s, depth + 1, on_solution)

    # ── Public API ───────────────────────────────────────────

    def query(self, goal, limit=50):
        results = []
        def on_solution(subst):
            results.append(deep_walk(goal, subst))
        self._solve([goal], {}, 0, on_solution)
        return results[:limit]

    def query_first(self, goal):
        try:
            def on_solution(subst):
                raise _Found(deep_walk(goal, subst))
            self._solve([goal], {}, 0, on_solution)
        except _Found as f:
            return f.result
        return None

    # ── Builtins ─────────────────────────────────────────────

    def _register_builtins(self):
        eng = self

        # not/1, \+/1
        def _not(goal, rest, subst, depth, on_sol):
            inner = deep_walk(goal[2][0], subst)
            found = [False]
            saved_vc = eng._var_counter
            def check(s):
                found[0] = True
            try:
                eng._solve([inner], subst, depth + 1, check)
            except _Found:
                found[0] = True
            eng._var_counter = saved_vc
            if not found[0]:
                eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["not/1"] = _not
        self.builtins["\\+/1"] = _not

        # =/2
        def _unify(goal, rest, subst, depth, on_sol):
            s = unify(goal[2][0], goal[2][1], subst)
            if s is not None:
                eng._solve(rest, s, depth + 1, on_sol)
        self.builtins["=/2"] = _unify

        # \=/2
        def _not_unify(goal, rest, subst, depth, on_sol):
            s = unify(goal[2][0], goal[2][1], subst)
            if s is None:
                eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["\\=/2"] = _not_unify

        # member/2
        def _member(goal, rest, subst, depth, on_sol):
            elem = goal[2][0]
            lst = deep_walk(goal[2][1], subst)
            while lst[0] == "compound" and lst[1] == "." and len(lst[2]) == 2:
                s = unify(elem, lst[2][0], subst)
                if s is not None:
                    eng._solve(rest, s, depth + 1, on_sol)
                lst = deep_walk(lst[2][1], subst)
        self.builtins["member/2"] = _member

        # nth1/3
        def _nth1(goal, rest, subst, depth, on_sol):
            idx = deep_walk(goal[2][0], subst)
            lst_term = deep_walk(goal[2][1], subst)
            elem = goal[2][2]
            i = 1
            while lst_term[0] == "compound" and lst_term[1] == "." and len(lst_term[2]) == 2:
                if idx[0] == "num":
                    if i == idx[1]:
                        s = unify(elem, lst_term[2][0], subst)
                        if s is not None:
                            eng._solve(rest, s, depth + 1, on_sol)
                        return
                else:
                    s = unify(idx, num(i), subst)
                    if s is not None:
                        s2 = unify(elem, lst_term[2][0], s)
                        if s2 is not None:
                            eng._solve(rest, s2, depth + 1, on_sol)
                lst_term = deep_walk(lst_term[2][1], subst)
                i += 1
        self.builtins["nth1/3"] = _nth1

        # replace/4
        def _replace(goal, rest, subst, depth, on_sol):
            lst_term = deep_walk(goal[2][0], subst)
            idx = deep_walk(goal[2][1], subst)
            val = deep_walk(goal[2][2], subst)
            result = goal[2][3]
            if idx[0] != "num":
                return
            items = []
            while lst_term[0] == "compound" and lst_term[1] == "." and len(lst_term[2]) == 2:
                items.append(lst_term[2][0])
                lst_term = deep_walk(lst_term[2][1], subst)
            if idx[1] < 1 or idx[1] > len(items):
                return
            new_items = list(items)
            new_items[idx[1] - 1] = val
            s = unify(result, lst(new_items), subst)
            if s is not None:
                eng._solve(rest, s, depth + 1, on_sol)
        self.builtins["replace/4"] = _replace

        # is/2
        def _is(goal, rest, subst, depth, on_sol):
            lhs = goal[2][0]
            rhs = deep_walk(goal[2][1], subst)
            val = _eval_arith(rhs)
            if val is not None:
                s = unify(lhs, num(val), subst)
                if s is not None:
                    eng._solve(rest, s, depth + 1, on_sol)
        self.builtins["is/2"] = _is

        # Comparison operators
        def _make_cmp(fn):
            def _cmp(goal, rest, subst, depth, on_sol):
                a = _eval_arith(deep_walk(goal[2][0], subst))
                b = _eval_arith(deep_walk(goal[2][1], subst))
                if a is not None and b is not None and fn(a, b):
                    eng._solve(rest, subst, depth + 1, on_sol)
            return _cmp

        self.builtins[">/2"]   = _make_cmp(lambda a, b: a > b)
        self.builtins["</2"]   = _make_cmp(lambda a, b: a < b)
        self.builtins[">=/2"]  = _make_cmp(lambda a, b: a >= b)
        self.builtins["=</2"]  = _make_cmp(lambda a, b: a <= b)
        self.builtins["=:=/2"] = _make_cmp(lambda a, b: a == b)
        self.builtins["=\\=/2"]= _make_cmp(lambda a, b: a != b)

        # ==/2, \==/2
        def _struct_eq(goal, rest, subst, depth, on_sol):
            a = deep_walk(goal[2][0], subst)
            b = deep_walk(goal[2][1], subst)
            if a == b:
                eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["==/2"] = _struct_eq

        def _struct_neq(goal, rest, subst, depth, on_sol):
            a = deep_walk(goal[2][0], subst)
            b = deep_walk(goal[2][1], subst)
            if a != b:
                eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["\\==/2"] = _struct_neq

        # true/0, fail/0
        def _true(goal, rest, subst, depth, on_sol):
            eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["true/0"] = _true
        self.builtins["fail/0"] = lambda *a: None

        # ,/2 conjunction
        def _conj(goal, rest, subst, depth, on_sol):
            eng._solve([goal[2][0], goal[2][1]] + rest, subst, depth + 1, on_sol)
        self.builtins[",/2"] = _conj

        # ;/2 disjunction / if-then-else
        def _disj(goal, rest, subst, depth, on_sol):
            left = deep_walk(goal[2][0], subst)
            right = deep_walk(goal[2][1], subst)
            if left[0] == "compound" and left[1] == "->" and len(left[2]) == 2:
                found = [False]
                def on_cond(s):
                    if not found[0]:
                        found[0] = True
                        eng._solve([left[2][1]] + rest, s, depth + 1, on_sol)
                eng._solve([left[2][0]], subst, depth + 1, on_cond)
                if not found[0]:
                    eng._solve([right] + rest, subst, depth + 1, on_sol)
            else:
                eng._solve([left] + rest, subst, depth + 1, on_sol)
                eng._solve([right] + rest, subst, depth + 1, on_sol)
        self.builtins[";/2"] = _disj

        # ->/2
        def _ifthen(goal, rest, subst, depth, on_sol):
            found = [False]
            def on_cond(s):
                if not found[0]:
                    found[0] = True
                    eng._solve([goal[2][1]] + rest, s, depth + 1, on_sol)
            eng._solve([goal[2][0]], subst, depth + 1, on_cond)
        self.builtins["->/2"] = _ifthen

        # assert/1, retract/1
        def _assert(goal, rest, subst, depth, on_sol):
            term = deep_walk(goal[2][0], subst)
            eng.clauses.append((term, []))
            eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["assert/1"] = _assert
        self.builtins["assertz/1"] = _assert

        def _retract(goal, rest, subst, depth, on_sol):
            term = deep_walk(goal[2][0], subst)
            if eng.retract_first(term):
                eng._solve(rest, subst, depth + 1, on_sol)
        self.builtins["retract/1"] = _retract

        # findall/3
        def _findall(goal, rest, subst, depth, on_sol):
            template = goal[2][0]
            query_goal = deep_walk(goal[2][1], subst)
            bag = goal[2][2]
            results = []
            saved_vc = eng._var_counter
            def collect(s):
                results.append(deep_walk(template, s))
            eng._solve([query_goal], subst, depth + 1, collect)
            eng._var_counter = saved_vc
            s = unify(bag, lst(results), subst)
            if s is not None:
                eng._solve(rest, s, depth + 1, on_sol)
        self.builtins["findall/3"] = _findall


# ── Arithmetic evaluator ─────────────────────────────────────

def _eval_arith(term):
    if term[0] == "num":
        return term[1]
    if term[0] == "compound":
        f, args = term[1], term[2]
        if f == "+" and len(args) == 2:
            a, b = _eval_arith(args[0]), _eval_arith(args[1])
            return a + b if a is not None and b is not None else None
        if f == "-" and len(args) == 2:
            a, b = _eval_arith(args[0]), _eval_arith(args[1])
            return a - b if a is not None and b is not None else None
        if f == "*" and len(args) == 2:
            a, b = _eval_arith(args[0]), _eval_arith(args[1])
            return a * b if a is not None and b is not None else None
        if f == "//" and len(args) == 2:
            a, b = _eval_arith(args[0]), _eval_arith(args[1])
            if a is not None and b is not None and b != 0:
                return int(a / b)
            return None
        if f == "mod" and len(args) == 2:
            a, b = _eval_arith(args[0]), _eval_arith(args[1])
            return a % b if a is not None and b is not None and b != 0 else None
        if f == "-" and len(args) == 1:
            a = _eval_arith(args[0])
            return -a if a is not None else None
    return None


# ── Utility ──────────────────────────────────────────────────

def term_to_str(term):
    if term is None:
        return "?"
    t = term[0]
    if t == "atom":
        return term[1]
    if t == "num":
        return str(term[1])
    if t == "var":
        return term[1]
    if t == "compound":
        f, args = term[1], term[2]
        if f == "." and len(args) == 2:
            items = []
            cur = term
            while cur[0] == "compound" and cur[1] == "." and len(cur[2]) == 2:
                items.append(term_to_str(cur[2][0]))
                cur = cur[2][1]
            if cur[0] == "atom" and cur[1] == "[]":
                return "[" + ",".join(items) + "]"
            return "[" + ",".join(items) + "|" + term_to_str(cur) + "]"
        return f + "(" + ",".join(term_to_str(a) for a in args) + ")"
    return "?"

def list_to_py(term):
    """Convert a Prolog list term to a Python list of terms."""
    items = []
    while term[0] == "compound" and term[1] == "." and len(term[2]) == 2:
        items.append(term[2][0])
        term = term[2][1]
    return items
