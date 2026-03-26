#!/usr/bin/env python3
# ============================================================
# test_y8_datalog.py — Tests for Y8 Datalog layer
# ============================================================

import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'vendor', 'qjson', 'src'))
sys.path.insert(0, os.path.dirname(__file__))

import sqlite3
from y8_datalog import Y8Datalog
from y8_loader import load_program
from qjson import Unbound

passed = 0
failed = 0

def test(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print("  \u2713 " + name)
    except Exception as e:
        failed += 1
        print("  \u2717 " + name + ": " + str(e))


def fresh_db():
    conn = sqlite3.connect(':memory:')
    db = Y8Datalog(conn)
    db.setup()
    return db


# ── Assert / query ───────────────────────────────────────────

def test_assert_and_query_all():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    results = db.query('parent')
    assert len(results) == 2, "expected 2 facts, got %d" % len(results)

def test_assert_idempotent():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['alice', 'bob'])
    results = db.query('parent')
    assert len(results) == 1, "double assert should be no-op"

def test_query_with_pattern():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    db.assert_fact('parent', ['carol', 'dave'])
    results = db.query('parent', [None, 'bob'])
    assert len(results) == 1, "expected 1 match, got %d" % len(results)
    assert results[0] == ['alice', 'bob']

def test_query_empty():
    db = fresh_db()
    results = db.query('parent')
    assert results == [], "empty predicate should return []"

# ── Retract ──────────────────────────────────────────────────

def test_retract():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    ok = db.retract('parent', ['alice', 'bob'])
    assert ok, "retract should succeed"
    results = db.query('parent')
    assert len(results) == 1
    assert results[0] == ['bob', 'carol']

def test_retract_missing():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    ok = db.retract('parent', ['no', 'such'])
    assert not ok, "retract missing should return False"

def test_retract_all():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['carol', 'bob'])
    db.assert_fact('parent', ['eve', 'frank'])
    count = db.retract_all('parent', [None, 'bob'])
    assert count == 2, "expected 2 retracted, got %d" % count
    results = db.query('parent')
    assert len(results) == 1
    assert results[0] == ['eve', 'frank']

# ── Callbacks ────────────────────────────────────────────────

def test_on_assert_callback():
    db = fresh_db()
    events = []
    db.on_assert.append(lambda pred, fact: events.append(('assert', pred, fact)))
    db.assert_fact('parent', ['alice', 'bob'])
    assert len(events) == 1
    assert events[0] == ('assert', 'parent', ['alice', 'bob'])

def test_on_retract_callback():
    db = fresh_db()
    events = []
    db.on_retract.append(lambda pred, fact: events.append(('retract', pred, fact)))
    db.assert_fact('parent', ['alice', 'bob'])
    db.retract('parent', ['alice', 'bob'])
    assert len(events) == 1
    assert events[0] == ('retract', 'parent', ['alice', 'bob'])

# ── React rules ──────────────────────────────────────────────

def test_react_on_assert():
    db = fresh_db()
    events = []
    db.add_react('assert', lambda et, pred, fact, db: events.append(fact))
    db.assert_fact('parent', ['alice', 'bob'])
    assert len(events) == 1
    assert events[0] == ['alice', 'bob']

def test_react_cascading():
    """React rule that asserts a derived fact on assert."""
    db = fresh_db()
    def on_parent_assert(et, pred, fact, db):
        if pred == 'parent':
            db.assert_fact('has_child', [fact[0]])
    db.add_react('assert', on_parent_assert)
    db.assert_fact('parent', ['alice', 'bob'])
    results = db.query('has_child')
    assert len(results) == 1
    assert results[0] == ['alice']

# ── Ephemeral events ─────────────────────────────────────────

def test_ephemeral():
    db = fresh_db()
    events = []
    db.add_react('signal', lambda et, pred, fact, db: events.append(fact))
    db.ephemeral('signal', 'temperature', ['sensor1', 35])
    assert len(events) == 1
    assert events[0] == ['sensor1', 35]
    # Signal not stored
    results = db.query('temperature')
    assert results == []

# ── Native hooks ─────────────────────────────────────────────

def test_native():
    db = fresh_db()
    db.register_native('double', lambda args: args[0] * 2)
    result = db.call_native('double', [21])
    assert result == 42

# ── Send ─────────────────────────────────────────────────────

def test_send():
    db = fresh_db()
    db.send('alerts', {'type': 'overheat', 'value': 35})
    sends = db.collect_sends()
    assert len(sends) == 1
    assert sends[0]['target'] == 'alerts'
    # Collected, buffer cleared
    assert db.collect_sends() == []

# ── Rules ────────────────────────────────────────────────────

def test_add_rule():
    db = fresh_db()
    db.add_rule([
        ['grandparent', Unbound('GP'), Unbound('GC')],
        ['parent', Unbound('GP'), Unbound('Y')],
        ['parent', Unbound('Y'), Unbound('GC')]
    ])
    # Rule stored — verify root has rules section
    root = db._adapter['load'](db._root_id)
    assert 'rules' in root
    assert 'grandparent' in root['rules']

# ── Resolve (facts + rules) ─────────────────────────────────

def test_resolve_facts():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    results = db.resolve('parent', [Unbound('X'), 'bob'])
    assert len(results) == 1
    assert results[0]['X'] == 'alice'

def test_resolve_all_facts():
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    results = db.resolve('parent', [Unbound('X'), Unbound('Y')])
    assert len(results) == 2
    names = sorted([r['X'] for r in results])
    assert names == ['alice', 'bob']

def test_resolve_grandparent():
    """grandparent(GP, GC) :- parent(GP, Y), parent(Y, GC)."""
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    db.assert_fact('parent', ['carol', 'dave'])

    db.add_rule([
        ['grandparent', Unbound('GP'), Unbound('GC')],
        ['parent', Unbound('GP'), Unbound('Y')],
        ['parent', Unbound('Y'), Unbound('GC')]
    ])

    results = db.resolve('grandparent', [Unbound('GP'), Unbound('GC')])
    gps = sorted([(r['GP'], r['GC']) for r in results])
    assert ('alice', 'carol') in gps, "alice is grandparent of carol"
    assert ('bob', 'dave') in gps, "bob is grandparent of dave"
    assert len(gps) == 2

def test_resolve_grandparent_filtered():
    """grandparent(alice, ?GC) — filter by concrete arg."""
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    db.assert_fact('parent', ['carol', 'dave'])

    db.add_rule([
        ['grandparent', Unbound('GP'), Unbound('GC')],
        ['parent', Unbound('GP'), Unbound('Y')],
        ['parent', Unbound('Y'), Unbound('GC')]
    ])

    results = db.resolve('grandparent', ['alice', Unbound('GC')])
    assert len(results) == 1
    assert results[0]['GC'] == 'carol'

def test_resolve_uncle():
    """uncle(X, Y) :- parent(Z, Y), sibling(X, Z)."""
    db = fresh_db()
    db.assert_fact('parent', ['bob', 'carol'])
    db.assert_fact('sibling', ['alice', 'bob'])

    db.add_rule([
        ['uncle', Unbound('X'), Unbound('Y')],
        ['parent', Unbound('Z'), Unbound('Y')],
        ['sibling', Unbound('X'), Unbound('Z')]
    ])

    results = db.resolve('uncle', [Unbound('X'), Unbound('Y')])
    assert len(results) >= 1
    assert any(r['X'] == 'alice' and r['Y'] == 'carol' for r in results), \
        "alice is uncle/aunt of carol"

# ── Run ──────────────────────────────────────────────────────

print("y8_datalog.py")
test("assert and query all", test_assert_and_query_all)
test("assert idempotent", test_assert_idempotent)
test("query with pattern", test_query_with_pattern)
test("query empty predicate", test_query_empty)
test("retract", test_retract)
test("retract missing", test_retract_missing)
test("retract all", test_retract_all)
test("on_assert callback", test_on_assert_callback)
test("on_retract callback", test_on_retract_callback)
test("react on assert", test_react_on_assert)
test("react cascading", test_react_cascading)
test("ephemeral", test_ephemeral)
test("native", test_native)
test("send", test_send)
test("add rule", test_add_rule)
test("resolve facts", test_resolve_facts)
test("resolve all facts", test_resolve_all_facts)
test("resolve grandparent", test_resolve_grandparent)
test("resolve grandparent filtered", test_resolve_grandparent_filtered)
test("resolve uncle", test_resolve_uncle)

# ── Recursive rules (transitive closure) ─────────────────────

def test_resolve_path():
    """path(X,Y) :- edge(X,Y). path(X,Y) :- edge(X,Z), path(Z,Y)."""
    db = fresh_db()
    db.assert_fact('edge', ['a', 'b'])
    db.assert_fact('edge', ['b', 'c'])
    db.assert_fact('edge', ['c', 'd'])

    # Base case
    db.add_rule([
        ['path', Unbound('X'), Unbound('Y')],
        ['edge', Unbound('X'), Unbound('Y')]
    ])
    # Recursive case
    db.add_rule([
        ['path', Unbound('X'), Unbound('Y')],
        ['edge', Unbound('X'), Unbound('Z')],
        ['path', Unbound('Z'), Unbound('Y')]
    ])

    results = db.resolve('path', ['a', Unbound('Y')])
    targets = sorted([r['Y'] for r in results])
    assert 'b' in targets, "a reaches b"
    assert 'c' in targets, "a reaches c"
    assert 'd' in targets, "a reaches d"

def test_resolve_path_filtered():
    """path(a, d) — specific start and end."""
    db = fresh_db()
    db.assert_fact('edge', ['a', 'b'])
    db.assert_fact('edge', ['b', 'c'])
    db.assert_fact('edge', ['c', 'd'])

    db.add_rule([
        ['path', Unbound('X'), Unbound('Y')],
        ['edge', Unbound('X'), Unbound('Y')]
    ])
    db.add_rule([
        ['path', Unbound('X'), Unbound('Y')],
        ['edge', Unbound('X'), Unbound('Z')],
        ['path', Unbound('Z'), Unbound('Y')]
    ])

    results = db.resolve('path', ['a', 'd'])
    assert len(results) >= 1, "a reaches d"

def test_resolve_ancestor():
    """ancestor(X,Y) :- parent(X,Y). ancestor(X,Y) :- parent(X,Z), ancestor(Z,Y)."""
    db = fresh_db()
    db.assert_fact('parent', ['alice', 'bob'])
    db.assert_fact('parent', ['bob', 'carol'])
    db.assert_fact('parent', ['carol', 'dave'])

    db.add_rule([
        ['ancestor', Unbound('X'), Unbound('Y')],
        ['parent', Unbound('X'), Unbound('Y')]
    ])
    db.add_rule([
        ['ancestor', Unbound('X'), Unbound('Y')],
        ['parent', Unbound('X'), Unbound('Z')],
        ['ancestor', Unbound('Z'), Unbound('Y')]
    ])

    results = db.resolve('ancestor', ['alice', Unbound('Y')])
    descendants = sorted([r['Y'] for r in results])
    assert 'bob' in descendants, "alice ancestor of bob"
    assert 'carol' in descendants, "alice ancestor of carol"
    assert 'dave' in descendants, "alice ancestor of dave"

# ── Prolog text loader ────────────────────────────────────────

def test_load_facts():
    db = fresh_db()
    count = load_program(db, """
        parent(alice, bob).
        parent(bob, carol).
    """)
    assert count == 2
    results = db.query('parent')
    assert len(results) == 2

def test_load_rule():
    db = fresh_db()
    load_program(db, """
        parent(alice, bob).
        parent(bob, carol).
        parent(carol, dave).
        grandparent(GP, GC) :- parent(GP, Y), parent(Y, GC).
    """)
    results = db.resolve('grandparent', [Unbound('GP'), Unbound('GC')])
    gps = [(r['GP'], r['GC']) for r in results]
    assert ('alice', 'carol') in gps
    assert ('bob', 'dave') in gps

def test_load_recursive():
    db = fresh_db()
    load_program(db, """
        edge(a, b).
        edge(b, c).
        edge(c, d).
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
    """)
    results = db.resolve('path', ['a', Unbound('Y')])
    targets = sorted([r['Y'] for r in results])
    assert 'b' in targets
    assert 'c' in targets
    assert 'd' in targets

def test_load_with_comments():
    db = fresh_db()
    count = load_program(db, """
        % This is a comment
        parent(alice, bob).  % inline comment
        /* block comment */
        parent(bob, carol).
    """)
    assert count == 2
    results = db.query('parent')
    assert len(results) == 2

def test_load_numbers():
    db = fresh_db()
    load_program(db, """
        price(btc, 67432).
        price(eth, 3500).
    """)
    results = db.query('price', [None, None])
    assert len(results) == 2

test("load facts", test_load_facts)
test("load rule", test_load_rule)
test("load recursive", test_load_recursive)
test("load with comments", test_load_with_comments)
test("load numbers", test_load_numbers)

# ── Body execution engine ────────────────────────────────────

def test_execute_is():
    db = fresh_db()
    bindings = {}
    ok = db.execute_body([
        ['is', Unbound('X'), ['+', 3, 4]]
    ], bindings)
    assert ok, "is should succeed"
    assert bindings['X'] == 7, "X should be 7, got %s" % bindings.get('X')

def test_execute_comparison():
    db = fresh_db()
    assert db.execute_body([['>', 5, 3]])
    assert not db.execute_body([['>', 3, 5]])
    assert db.execute_body([['>=', 5, 5]])
    assert db.execute_body([['=<', 3, 5]])

def test_execute_not():
    db = fresh_db()
    db.assert_fact('color', ['red'])
    assert db.execute_body([['not', ['color', 'blue']]])
    assert not db.execute_body([['not', ['color', 'red']]])

def test_execute_assert_retract():
    db = fresh_db()
    db.execute_body([
        ['assert', ['counter', 0]]
    ])
    results = db.query('counter')
    assert len(results) == 1
    assert results[0] == [0], "got %s" % results[0]

    db.execute_body([
        ['retract', ['counter', 0]],
        ['assert', ['counter', 1]]
    ])
    results = db.query('counter')
    assert len(results) == 1
    assert results[0] == [1]

def test_execute_query_and_bind():
    db = fresh_db()
    db.assert_fact('credit', [100])
    bindings = {}
    ok = db.execute_body([
        ['credit', Unbound('C')]
    ], bindings)
    assert ok
    assert bindings['C'] == 100, "C should be 100, got %s" % bindings.get('C')

def test_execute_coin_insert():
    """Simulate vending machine coin insert."""
    db = fresh_db()
    db.assert_fact('credit', [0])

    bindings = {}
    # credit(Old), is(New, Old + 25), retract(credit(Old)), assert(credit(New))
    ok = db.execute_body([
        ['credit', Unbound('Old')],
        ['is', Unbound('New'), ['+', Unbound('Old'), 25]],
        ['retract', ['credit', Unbound('Old')]],
        ['assert', ['credit', Unbound('New')]],
    ], bindings)
    assert ok
    assert bindings['New'] == 25

    results = db.query('credit')
    assert len(results) == 1
    assert results[0] == [25], "credit should be 25, got %s" % results[0]

def test_execute_findall():
    db = fresh_db()
    db.assert_fact('color', ['red'])
    db.assert_fact('color', ['green'])
    db.assert_fact('color', ['blue'])

    bindings = {}
    ok = db.execute_body([
        ['findall', Unbound('X'), ['color', Unbound('X')], Unbound('Bag')]
    ], bindings)
    assert ok
    assert len(bindings['Bag']) == 3

def test_react_with_body():
    """React clause: on assert to credit, if credit > 100, assert rich."""
    db = fresh_db()
    db.add_react_clause('assert', [
        ['credit', Unbound('C')],
        ['>', Unbound('C'), 100],
        ['assert', ['rich', True]]
    ])
    db.assert_fact('credit', [50])
    assert len(db.query('rich')) == 0, "50 is not rich"
    db.retract('credit', [50])
    db.assert_fact('credit', [200])
    assert len(db.query('rich')) == 1, "200 should be rich"

test("execute is/2", test_execute_is)
test("execute comparisons", test_execute_comparison)
test("execute not/1", test_execute_not)
test("execute assert/retract", test_execute_assert_retract)
test("execute query and bind", test_execute_query_and_bind)
test("execute coin insert", test_execute_coin_insert)
test("execute findall", test_execute_findall)
test("react with body clause", test_react_with_body)

test("resolve path (recursive)", test_resolve_path)
test("resolve path filtered", test_resolve_path_filtered)
test("resolve ancestor", test_resolve_ancestor)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
