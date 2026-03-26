# ============================================================
# y8_datalog.py — Reactive Datalog over QJSON
#
# Thin wrapper: Prolog-style assert/retract/query over QJSON's
# normalized SQL storage.  Facts are set members.  Rules compile
# to SQL joins via qjson_select.  Ephemeral events flow through
# react rules without touching storage.
#
# Usage:
#   import sqlite3
#   from y8_datalog import Y8Datalog
#
#   conn = sqlite3.connect(':memory:')
#   db = Y8Datalog(conn)
#   db.setup()
#
#   db.assert_fact('parent', ['alice', 'bob'])
#   db.assert_fact('parent', ['bob', 'carol'])
#   results = db.query('parent', [None, 'bob'])
#   # → [['alice', 'bob']]
# ============================================================

import sys
import os

# Import qjson from vendor
_vendor = os.path.join(os.path.dirname(__file__), '..', 'vendor', 'qjson', 'src')
if _vendor not in sys.path:
    sys.path.insert(0, _vendor)

from qjson import parse, stringify, Unbound, QMap
from qjson_sql import qjson_sql_adapter
from qjson_query import qjson_select, qjson_closure


class Y8Datalog:
    """Reactive Datalog engine backed by QJSON SQL storage."""

    def __init__(self, conn, prefix="qjson_", root_id=None):
        self._conn = conn
        self._prefix = prefix
        self._adapter = qjson_sql_adapter(conn, prefix=prefix)
        self._root_id = root_id
        self._natives = {}        # name → fn(args) → result
        self._sends = []          # [{target, fact}]
        self.on_assert = []       # callbacks: fn(predicate, fact)
        self.on_retract = []      # callbacks: fn(predicate, fact)
        self._react_rules = []    # [{pattern, body_fn}]
        self._has_ext = False

    def setup(self):
        """Initialize storage.  Creates tables and root document."""
        self._adapter['setup']()
        if self._root_id is None:
            self._root_id = self._adapter['store']({})
            self._adapter['commit']()
        # Try loading qjson extension for cross-path comparison
        try:
            self._conn.enable_load_extension(True)
            base = os.path.dirname(os.path.abspath(__file__))
            ext_paths = [
                os.path.join(base, '..', 'vendor', 'qjson', 'qjson_ext'),
                os.path.join(base, '..', 'vendor', 'qjson', 'native', 'qjson_ext'),
            ]
            for path in ext_paths:
                path = os.path.abspath(path)
                try:
                    self._conn.load_extension(path)
                    self._has_ext = True
                    break
                except Exception:
                    pass
        except Exception:
            pass

    @property
    def root_id(self):
        return self._root_id

    # ── Facts (set operations) ────────────────────────────────

    def assert_fact(self, predicate, args):
        """Assert a fact: insert tuple into predicate set.

        predicate — string name (e.g., 'parent')
        args — list of values (e.g., ['alice', 'bob'])

        Idempotent: double-assert is a no-op (set semantics).
        Fires on_assert callbacks and react rules.
        """
        # Load current root
        root = self._adapter['load'](self._root_id)
        if root is None:
            root = {}

        # Get or create predicate set
        pred_set = root.get(predicate)
        if pred_set is None:
            pred_set = QMap()
            root[predicate] = pred_set

        # Check if fact already exists (set semantics)
        fact_tuple = list(args)
        for k, v in (pred_set.entries if isinstance(pred_set, QMap) else pred_set.items()):
            if k == fact_tuple:
                return  # already asserted

        # Add to set
        if isinstance(pred_set, QMap):
            pred_set.entries.append((fact_tuple, True))
        else:
            # Convert dict to QMap if needed (tuple keys aren't strings)
            new_set = QMap(list(pred_set.items()))
            new_set.entries.append((fact_tuple, True))
            root[predicate] = new_set

        # Re-store the root
        self._adapter['remove'](self._root_id)
        self._root_id = self._adapter['store'](root)
        self._adapter['commit']()

        # Fire callbacks
        for cb in self.on_assert:
            cb(predicate, fact_tuple)

        # Fire react rules
        self._fire_react('assert', predicate, fact_tuple)

    def retract(self, predicate, args):
        """Retract a fact: remove exact tuple from predicate set.

        Returns True if fact was found and removed, False otherwise.
        Fires on_retract callbacks and react rules.
        """
        root = self._adapter['load'](self._root_id)
        if root is None:
            return False

        pred_set = root.get(predicate)
        if pred_set is None:
            return False

        fact_tuple = list(args)
        entries = pred_set.entries if isinstance(pred_set, QMap) else list(pred_set.items())
        new_entries = [(k, v) for k, v in entries if k != fact_tuple]

        if len(new_entries) == len(entries):
            return False  # not found

        root[predicate] = QMap(new_entries)
        self._adapter['remove'](self._root_id)
        self._root_id = self._adapter['store'](root)
        self._adapter['commit']()

        for cb in self.on_retract:
            cb(predicate, fact_tuple)
        self._fire_react('retract', predicate, fact_tuple)
        return True

    def retract_all(self, predicate, pattern):
        """Retract all facts matching pattern.

        pattern — list where None/Unbound matches anything.
        Returns count of retracted facts.
        """
        root = self._adapter['load'](self._root_id)
        if root is None:
            return 0

        pred_set = root.get(predicate)
        if pred_set is None:
            return 0

        entries = pred_set.entries if isinstance(pred_set, QMap) else list(pred_set.items())
        keep = []
        removed = []
        for k, v in entries:
            if _matches(k, pattern):
                removed.append(k)
            else:
                keep.append((k, v))

        if not removed:
            return 0

        root[predicate] = QMap(keep)
        self._adapter['remove'](self._root_id)
        self._root_id = self._adapter['store'](root)
        self._adapter['commit']()

        for fact in removed:
            for cb in self.on_retract:
                cb(predicate, fact)
            self._fire_react('retract', predicate, fact)

        return len(removed)

    # ── Query ─────────────────────────────────────────────────

    def query(self, predicate, pattern=None):
        """Query facts matching a pattern.

        predicate — string name
        pattern — list where None/Unbound means unbound.
                  If None, returns all facts.

        Returns list of fact tuples (as lists).
        """
        if pattern is None:
            # Return all facts
            select_path = '.%s[K]' % predicate
            results = qjson_select(self._conn, self._root_id,
                                   select_path, prefix=self._prefix,
                                   has_ext=self._has_ext)
            return [self._adapter['load'](vid) for vid, _ in results]

        # Build WHERE clause from pattern
        conditions = []
        for i, arg in enumerate(pattern):
            if arg is not None and not isinstance(arg, Unbound):
                val = stringify(arg) if not isinstance(arg, str) else '"%s"' % arg
                conditions.append('.%s[K][%d] == %s' % (predicate, i, val))

        select_path = '.%s[K]' % predicate
        where_expr = ' AND '.join(conditions) if conditions else None

        results = qjson_select(self._conn, self._root_id,
                               select_path, where_expr=where_expr,
                               prefix=self._prefix, has_ext=self._has_ext)
        return [self._adapter['load'](vid) for vid, _ in results]

    def query_join(self, select_path, where_expr):
        """Raw qjson_select query for joins and complex patterns.

        select_path — e.g., '.parent[K1][0]'
        where_expr — e.g., '.parent[K1][1] == .parent[K2][0]'

        Returns list of (value, bindings) tuples.
        """
        results = qjson_select(self._conn, self._root_id,
                               select_path, where_expr=where_expr,
                               prefix=self._prefix, has_ext=self._has_ext)
        return [(self._adapter['load'](vid), bindings)
                for vid, bindings in results]

    # ── Rules ─────────────────────────────────────────────────

    def add_rule(self, clause):
        """Add a rule (clause).

        clause — [head, body1, body2, ...] where each goal is
                 [predicate, arg1, arg2, ...] with Unbound for vars.

        Stored in root.rules.<head_predicate> set.
        """
        head = clause[0]
        pred_name = head[0]

        root = self._adapter['load'](self._root_id)
        if root is None:
            root = {}

        if 'rules' not in root:
            root['rules'] = {}
        rules = root['rules']

        if pred_name not in rules:
            rules[pred_name] = QMap()
        rule_set = rules[pred_name]

        # Store clause as set member
        if isinstance(rule_set, QMap):
            # Check for duplicate
            for k, _ in rule_set.entries:
                if k == clause:
                    return
            rule_set.entries.append((clause, True))
        else:
            new_set = QMap(list(rule_set.items()))
            new_set.entries.append((clause, True))
            rules[pred_name] = new_set

        self._adapter['remove'](self._root_id)
        self._root_id = self._adapter['store'](root)
        self._adapter['commit']()

    # ── Resolve (facts + rules) ─────────────────────────────

    def resolve(self, predicate, pattern=None):
        """Resolve a predicate: check facts, then compile rules.

        predicate — string name
        pattern — list where None/Unbound means unbound.

        Returns list of binding dicts: [{'X': 'alice', 'Y': 'bob'}, ...]
        For facts, bindings map pattern positions to values.
        For rules, bindings come from head variable positions.
        """
        results = []

        # 1. Direct fact lookup
        facts = self.query(predicate, pattern)
        for fact in facts:
            bindings = {}
            if pattern:
                for i, arg in enumerate(pattern):
                    if isinstance(arg, Unbound) and arg.name:
                        bindings[arg.name] = fact[i]
                    elif arg is None:
                        bindings[str(i)] = fact[i]
            results.append(bindings)

        # 2. Rule resolution
        root = self._adapter['load'](self._root_id)
        if root and 'rules' in root and predicate in root['rules']:
            rule_set = root['rules'][predicate]
            entries = rule_set.entries if isinstance(rule_set, QMap) else list(rule_set.items())
            for clause, _ in entries:
                rule_results = self._resolve_rule(clause, pattern)
                results.extend(rule_results)

        # Deduplicate
        seen = set()
        unique = []
        for b in results:
            key = tuple(sorted(b.items()))
            if key not in seen:
                seen.add(key)
                unique.append(b)
        return unique

    def _resolve_rule(self, clause, pattern):
        """Compile a rule clause to qjson_select calls and execute.

        clause — [head, body1, body2, ...]
        pattern — query pattern for the head (None/Unbound = any)

        Returns list of binding dicts.
        """
        head = clause[0]
        body = clause[1:]
        if not body:
            return []

        head_pred = head[0]

        # Detect recursion: body goal references head predicate
        # For binary relations, use qjson_closure for transitive closure
        recursive_goals = [g for g in body if g[0] == head_pred]
        if recursive_goals and len(head) == 3:
            return self._resolve_recursive(clause, pattern)


        # Map variables to their locations: var_name → [(goal_idx, arg_pos)]
        var_locs = {}
        for gi, goal in enumerate(body):
            for ai in range(1, len(goal)):
                arg = goal[ai]
                if isinstance(arg, Unbound) and arg.name:
                    if arg.name not in var_locs:
                        var_locs[arg.name] = []
                    var_locs[arg.name].append((gi, ai - 1))

        # Assign K-variable names to body goals
        k_names = ['K%d' % (i + 1) for i in range(len(body))]

        # Build WHERE conditions
        conditions = []

        # Shared variables across body goals → equijoin
        for var_name, locs in var_locs.items():
            if len(locs) >= 2:
                for j in range(1, len(locs)):
                    gi_a, ai_a = locs[0]
                    gi_b, ai_b = locs[j]
                    conditions.append('.%s[%s][%d] == .%s[%s][%d]' % (
                        body[gi_a][0], k_names[gi_a], ai_a,
                        body[gi_b][0], k_names[gi_b], ai_b))

        # Concrete values from pattern → filter conditions
        if pattern:
            for hi in range(len(pattern)):
                arg = pattern[hi]
                if arg is not None and not isinstance(arg, Unbound):
                    head_arg = head[hi + 1] if hi + 1 < len(head) else None
                    if isinstance(head_arg, Unbound) and head_arg.name in var_locs:
                        gi, ai = var_locs[head_arg.name][0]
                        val = '"%s"' % arg if isinstance(arg, str) else stringify(arg)
                        conditions.append('.%s[%s][%d] == %s' % (
                            body[gi][0], k_names[gi], ai, val))

        where_expr = ' AND '.join(conditions) if conditions else None

        # For each head variable, find its location in a body goal and
        # run a separate select to get that specific arg value
        head_vars = []
        for hi in range(1, len(head)):
            head_arg = head[hi]
            if isinstance(head_arg, Unbound) and head_arg.name:
                if head_arg.name in var_locs:
                    gi, ai = var_locs[head_arg.name][0]
                    head_vars.append((head_arg.name, gi, ai))

        if not head_vars:
            return []

        # Query each head variable's value
        # Strategy: for each head var, select its arg from the body goal,
        # with the same WHERE. K bindings tie the rows together.
        var_results = {}
        for var_name, gi, ai in head_vars:
            select_path = '.%s[%s][%d]' % (body[gi][0], k_names[gi], ai)
            try:
                rows = qjson_select(self._conn, self._root_id,
                                    select_path, where_expr=where_expr,
                                    prefix=self._prefix, has_ext=self._has_ext)
                var_results[var_name] = rows
            except Exception:
                var_results[var_name] = []

        # Combine: join variable results by their K bindings
        if not var_results:
            return []

        # Use first variable's results as the base
        first_var = head_vars[0][0]
        base_rows = var_results[first_var]

        results = []
        for vid, k_bindings in base_rows:
            bindings = {first_var: self._adapter['load'](vid)}
            # Match other variables by K bindings
            k_key = tuple(sorted(k_bindings.items()))
            for var_name, gi, ai in head_vars[1:]:
                for other_vid, other_kb in var_results[var_name]:
                    other_key = tuple(sorted(other_kb.items()))
                    if other_key == k_key:
                        bindings[var_name] = self._adapter['load'](other_vid)
                        break
            if len(bindings) == len(head_vars):
                results.append(bindings)
        return results

    def _resolve_recursive(self, clause, pattern):
        """Resolve a recursive rule via qjson_closure (transitive closure).

        Works for binary relations: pred(X, Y) :- base(X, Y) + pred chain.
        Uses WITH RECURSIVE under the hood.
        """
        head = clause[0]
        body = clause[1:]
        head_pred = head[0]

        # Find the base predicate (non-recursive body goal)
        base_goals = [g for g in body if g[0] != head_pred]
        if not base_goals:
            return []  # all recursive, no base case

        base_pred = base_goals[0][0]

        # Build from/to filters from pattern
        where_from = None
        where_to = None
        if pattern:
            if len(pattern) >= 1 and pattern[0] is not None and not isinstance(pattern[0], Unbound):
                where_from = str(pattern[0])
            if len(pattern) >= 2 and pattern[1] is not None and not isinstance(pattern[1], Unbound):
                where_to = str(pattern[1])

        try:
            pairs = qjson_closure(self._conn, self._root_id,
                                  '.%s' % base_pred,
                                  where_from=where_from,
                                  where_to=where_to,
                                  prefix=self._prefix)
        except Exception:
            return []

        # Map pairs to bindings (closure returns QJSON strings, parse them)
        results = []
        for from_val, to_val in pairs:
            from_parsed = parse(from_val) if isinstance(from_val, str) else from_val
            to_parsed = parse(to_val) if isinstance(to_val, str) else to_val
            bindings = {}
            if len(head) >= 2:
                h1 = head[1]
                if isinstance(h1, Unbound) and h1.name:
                    bindings[h1.name] = from_parsed
            if len(head) >= 3:
                h2 = head[2]
                if isinstance(h2, Unbound) and h2.name:
                    bindings[h2.name] = to_parsed
            results.append(bindings)
        return results

    # ── Body execution engine ─────────────────────────────────
    # Executes body goals in sequence with accumulating bindings.
    # Handles: query goals, not, assert, retract, retractall,
    # is, >, <, >=, =<, =:=, =\=, findall.

    def execute_body(self, body, bindings=None):
        """Execute a list of body goals with bindings.

        body — list of goals (each is [functor, arg1, arg2, ...])
        bindings — dict of var_name → value (modified in place)

        Returns True if all goals succeed.
        """
        if bindings is None:
            bindings = {}
        for goal in body:
            if not self._execute_goal(goal, bindings):
                return False
        return True

    def _execute_goal(self, goal, bindings):
        """Execute a single goal. Returns True if succeeds."""
        if not isinstance(goal, list) or len(goal) == 0:
            return False

        functor = goal[0]
        args = goal[1:]

        # ── Negation ──────────────────────────────────────
        if functor in ('not', '\\+'):
            inner = self._resolve_term(args[0], bindings)
            return not self._execute_goal(inner, dict(bindings))

        # ── Assert ────────────────────────────────────────
        if functor in ('assert', 'assertz'):
            inner = self._resolve_term(args[0], bindings)
            if isinstance(inner, list) and len(inner) >= 1:
                self.assert_fact(inner[0], inner[1:])
            return True

        # ── Retract ───────────────────────────────────────
        if functor == 'retract':
            inner = self._resolve_term(args[0], bindings)
            if isinstance(inner, list) and len(inner) >= 1:
                return self.retract(inner[0], inner[1:])
            return False

        # ── Retractall ────────────────────────────────────
        if functor == 'retractall':
            inner = self._resolve_term(args[0], bindings)
            if isinstance(inner, list) and len(inner) >= 1:
                self.retract_all(inner[0], inner[1:])
            return True

        # ── Arithmetic is/2 ───────────────────────────────
        if functor == 'is':
            lhs = args[0]
            rhs = args[1]
            val = self._eval_arith(rhs, bindings)
            if val is None:
                return False
            if isinstance(lhs, Unbound) and lhs.name:
                bindings[lhs.name] = val
            return True

        # ── Comparisons ───────────────────────────────────
        if functor in ('>', '<', '>=', '=<', '=:=', '=\\='):
            a = self._eval_arith(args[0], bindings)
            b = self._eval_arith(args[1], bindings)
            if a is None or b is None:
                return False
            if functor == '>':   return a > b
            if functor == '<':   return a < b
            if functor == '>=':  return a >= b
            if functor == '=<':  return a <= b
            if functor == '=:=': return a == b
            if functor == '=\\=': return a != b

        # ── Findall ───────────────────────────────────────
        if functor == 'findall':
            template = args[0]
            inner_goal = args[1]
            bag_var = args[2]
            # Query all matching facts for the inner goal
            resolved_goal = self._resolve_term(inner_goal, bindings)
            if isinstance(resolved_goal, list) and len(resolved_goal) >= 1:
                pred = resolved_goal[0]
                pattern = resolved_goal[1:]
                # Replace Unbound with None for query
                qpat = [None if isinstance(a, Unbound) else a for a in pattern]
                facts = self.query(pred, qpat)
                if isinstance(bag_var, Unbound) and bag_var.name:
                    bindings[bag_var.name] = facts
            return True

        # ── Default: query goal ───────────────────────────
        resolved = self._resolve_term(goal, bindings)
        if isinstance(resolved, list) and len(resolved) >= 1:
            pred = resolved[0]
            pattern = resolved[1:]
            # Build query pattern: bound values stay, unbound → None
            qpat = []
            for a in pattern:
                if isinstance(a, Unbound):
                    qpat.append(None)
                else:
                    qpat.append(a)
            facts = self.query(pred, qpat)
            if not facts:
                return False
            # Bind unbound variables from first matching fact
            first = facts[0]
            for i, a in enumerate(pattern):
                if isinstance(a, Unbound) and a.name and i < len(first):
                    bindings[a.name] = first[i]
            return True
        return False

    def _resolve_term(self, term, bindings):
        """Substitute bound variables in a term."""
        if isinstance(term, Unbound) and term.name in bindings:
            return bindings[term.name]
        if isinstance(term, list):
            return [self._resolve_term(x, bindings) for x in term]
        return term

    def _eval_arith(self, expr, bindings):
        """Evaluate arithmetic expression with bindings."""
        if isinstance(expr, Unbound):
            if expr.name in bindings:
                v = bindings[expr.name]
                return v if isinstance(v, (int, float)) else None
            return None
        if isinstance(expr, (int, float)):
            return expr
        if isinstance(expr, str):
            # QJSON bignum string — extract numeric value
            if expr and expr[-1] in 'NnMmLl':
                try:
                    return float(expr[:-1])
                except ValueError:
                    pass
            return None
        if isinstance(expr, list) and len(expr) >= 2:
            op = expr[0]
            if op == '+' and len(expr) == 3:
                a = self._eval_arith(expr[1], bindings)
                b = self._eval_arith(expr[2], bindings)
                return a + b if a is not None and b is not None else None
            if op == '-' and len(expr) == 3:
                a = self._eval_arith(expr[1], bindings)
                b = self._eval_arith(expr[2], bindings)
                return a - b if a is not None and b is not None else None
            if op == '*' and len(expr) == 3:
                a = self._eval_arith(expr[1], bindings)
                b = self._eval_arith(expr[2], bindings)
                return a * b if a is not None and b is not None else None
            if op == '//' and len(expr) == 3:
                a = self._eval_arith(expr[1], bindings)
                b = self._eval_arith(expr[2], bindings)
                return int(a // b) if a is not None and b is not None and b != 0 else None
            if op == 'mod' and len(expr) == 3:
                a = self._eval_arith(expr[1], bindings)
                b = self._eval_arith(expr[2], bindings)
                return a % b if a is not None and b is not None and b != 0 else None
            if op == 'abs' and len(expr) == 2:
                a = self._eval_arith(expr[1], bindings)
                return abs(a) if a is not None else None
            if op == '-' and len(expr) == 2:
                a = self._eval_arith(expr[1], bindings)
                return -a if a is not None else None
        return None

    # ── React rules ───────────────────────────────────────────

    def add_react(self, event_pattern, handler):
        """Register a react rule (Python callback).

        event_pattern — string: 'assert', 'retract', or custom
        handler — fn(event_type, predicate, fact, db) called on match
        """
        self._react_rules.append({
            'pattern': event_pattern,
            'handler': handler
        })

    def add_react_clause(self, event_pattern, body):
        """Register a react rule as a clause (body goals executed on match).

        event_pattern — match pattern (string for event type)
        body — list of goals to execute when event fires

        Body goals can include assert/retract/is/comparisons.
        """
        self._react_rules.append({
            'pattern': event_pattern,
            'handler': lambda et, pred, fact, db: db.execute_body(body, {
                '_event_type': et, '_predicate': pred, '_fact': fact
            }),
            'body': body
        })

    def _fire_react(self, event_type, predicate, fact):
        """Fire matching react rules (Python callbacks + stored clauses)."""
        # Python callbacks
        for rule in self._react_rules:
            if rule['pattern'] == event_type or rule['pattern'] == '*':
                try:
                    rule['handler'](event_type, predicate, fact, self)
                except Exception:
                    pass

    # ── Ephemeral events ──────────────────────────────────────

    def ephemeral(self, event_type, predicate, fact):
        """Fire an ephemeral event.

        The event flows through react rules but is never stored.
        """
        self._fire_react(event_type, predicate, fact)

    # ── Native hooks ──────────────────────────────────────────

    def register_native(self, name, fn):
        """Register a host function callable from react rules.

        name — function name
        fn — fn(args) → result
        """
        self._natives[name] = fn

    def call_native(self, name, args):
        """Call a registered native function."""
        if name not in self._natives:
            return None
        return self._natives[name](args)

    # ── Send ──────────────────────────────────────────────────

    def send(self, target, message):
        """Buffer an outgoing message."""
        self._sends.append({'target': target, 'message': message})

    def collect_sends(self):
        """Collect and clear buffered sends."""
        sends = self._sends[:]
        self._sends = []
        return sends


# ── Pattern matching helper ───────────────────────────────────

def _matches(fact, pattern):
    """Check if a fact tuple matches a pattern.

    Pattern elements that are None or Unbound match anything.
    """
    if not isinstance(fact, (list, tuple)):
        return False
    if len(fact) != len(pattern):
        return False
    for f, p in zip(fact, pattern):
        if p is None or isinstance(p, Unbound):
            continue
        if f != p:
            return False
    return True
