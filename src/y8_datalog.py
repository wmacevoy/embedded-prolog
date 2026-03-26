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
from qjson_query import qjson_select


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
        # Try loading qjson extension for query support
        try:
            self._conn.enable_load_extension(True)
            ext_dir = os.path.join(os.path.dirname(__file__), '..',
                                   'vendor', 'qjson')
            for ext in ['qjson_ext', 'qjson_ext.dylib', 'qjson_ext.so']:
                path = os.path.join(ext_dir, ext.split('.')[0])
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

    # ── React rules ───────────────────────────────────────────

    def add_react(self, event_pattern, handler):
        """Register a react rule.

        event_pattern — string: 'assert', 'retract', or custom
        handler — fn(event_type, predicate, fact, db) called on match

        React rules fire on assert/retract and ephemeral events.
        They are engine-side (not stored in SQL).
        """
        self._react_rules.append({
            'pattern': event_pattern,
            'handler': handler
        })

    def _fire_react(self, event_type, predicate, fact):
        """Fire matching react rules."""
        for rule in self._react_rules:
            if rule['pattern'] == event_type or rule['pattern'] == '*':
                try:
                    rule['handler'](event_type, predicate, fact, self)
                except Exception:
                    pass  # react rules don't propagate errors

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
