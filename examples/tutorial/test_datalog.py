#!/usr/bin/env python3
# ============================================================
# test_datalog.py — Tutorial: Y8 Datalog from zero
#
# Mirrors the JS tutorial steps but using the Datalog layer.
# All state in SQLite. Prolog text parsed and compiled to SQL.
#
# Run: python3 examples/tutorial/test_datalog.py
# ============================================================

import sys, os
_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_dir, '..', '..', 'vendor', 'qjson', 'src'))
sys.path.insert(0, os.path.join(_dir, '..', '..', 'src'))

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

def fresh():
    conn = sqlite3.connect(':memory:')
    db = Y8Datalog(conn)
    db.setup()
    return db


print("\n  Tutorial — Y8 Datalog\n")

# ── Step 1: Facts ────────────────────────────────────────────

def test_facts():
    db = fresh()
    load_program(db, """
        likes(alice, pizza).
        likes(alice, sushi).
        likes(bob, pizza).
        likes(bob, tacos).
    """)
    results = db.query('likes')
    assert len(results) == 4, "expected 4 facts"

def test_query_facts():
    db = fresh()
    load_program(db, """
        likes(alice, pizza).
        likes(alice, sushi).
        likes(bob, pizza).
    """)
    # What does alice like?
    results = db.query('likes', ['alice', None])
    assert len(results) == 2
    foods = sorted([r[1] for r in results])
    assert foods == ['pizza', 'sushi']

    # Who likes pizza?
    results = db.query('likes', [None, 'pizza'])
    assert len(results) == 2

test("step 1: assert facts", test_facts)
test("step 1: query facts", test_query_facts)

# ── Step 2: Rules ────────────────────────────────────────────

def test_rules():
    db = fresh()
    load_program(db, """
        parent(alice, bob).
        parent(bob, carol).
        grandparent(GP, GC) :- parent(GP, Y), parent(Y, GC).
    """)
    results = db.resolve('grandparent', [Unbound('GP'), Unbound('GC')])
    assert len(results) == 1
    assert results[0]['GP'] == 'alice'
    assert results[0]['GC'] == 'carol'

def test_multi_predicate_rule():
    db = fresh()
    load_program(db, """
        parent(bob, carol).
        sibling(alice, bob).
        uncle(U, N) :- sibling(U, P), parent(P, N).
    """)
    results = db.resolve('uncle', [Unbound('U'), Unbound('N')])
    assert any(r['U'] == 'alice' and r['N'] == 'carol' for r in results)

test("step 2: grandparent rule", test_rules)
test("step 2: multi-predicate rule", test_multi_predicate_rule)

# ── Step 3: Arithmetic ──────────────────────────────────────

def test_arithmetic():
    db = fresh()
    bindings = {}
    db.execute_body([
        ['is', Unbound('X'), ['+', 3, 4]],
        ['is', Unbound('Y'), ['*', Unbound('X'), 2]],
    ], bindings)
    assert bindings['X'] == 7
    assert bindings['Y'] == 14

def test_comparisons():
    db = fresh()
    assert db.execute_body([['>', 10, 5]])
    assert not db.execute_body([['>', 5, 10]])
    assert db.execute_body([['>=', 5, 5]])
    assert db.execute_body([['=<', 3, 7]])

test("step 3: arithmetic (is/2)", test_arithmetic)
test("step 3: comparisons", test_comparisons)

# ── Step 4: Dynamic state ───────────────────────────────────

def test_dynamic():
    db = fresh()
    db.assert_fact('counter', [0])

    # Increment
    bindings = {}
    db.execute_body([
        ['counter', Unbound('Old')],
        ['is', Unbound('New'), ['+', Unbound('Old'), 1]],
        ['retract', ['counter', Unbound('Old')]],
        ['assert', ['counter', Unbound('New')]],
    ], bindings)

    results = db.query('counter')
    assert results[0][0] == 1

    # Increment again
    bindings = {}
    db.execute_body([
        ['counter', Unbound('Old')],
        ['is', Unbound('New'), ['+', Unbound('Old'), 1]],
        ['retract', ['counter', Unbound('Old')]],
        ['assert', ['counter', Unbound('New')]],
    ], bindings)

    results = db.query('counter')
    assert results[0][0] == 2

test("step 4: dynamic assert/retract", test_dynamic)

# ── Step 5: Negation and findall ─────────────────────────────

def test_negation():
    db = fresh()
    db.assert_fact('color', ['red'])
    db.assert_fact('color', ['green'])

    # blue is NOT a color
    assert db.execute_body([['not', ['color', 'blue']]])
    # red IS a color
    assert not db.execute_body([['not', ['color', 'red']]])

def test_findall():
    db = fresh()
    load_program(db, """
        fruit(apple).
        fruit(banana).
        fruit(cherry).
    """)
    bindings = {}
    db.execute_body([
        ['findall', Unbound('X'), ['fruit', Unbound('X')], Unbound('Bag')]
    ], bindings)
    assert len(bindings['Bag']) == 3

test("step 5: negation (not/1)", test_negation)
test("step 5: findall/3", test_findall)

# ── Step 6: Recursive rules ─────────────────────────────────

def test_recursive():
    db = fresh()
    load_program(db, """
        edge(a, b).
        edge(b, c).
        edge(c, d).
        edge(d, e).
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
    """)
    results = db.resolve('path', ['a', Unbound('Y')])
    targets = sorted([r['Y'] for r in results])
    assert targets == ['b', 'c', 'd', 'e'], "got %s" % targets

test("step 6: recursive path (transitive closure)", test_recursive)

# ── Step 7: React + ephemeral ────────────────────────────────

def test_react():
    db = fresh()
    load_program(db, """
        sensor(temp, 20).
    """)
    log = []
    db.add_react('sensor_update', lambda et, pred, fact, db: (
        log.append(('update', fact)),
    ))

    # Simulate sensor update
    db.execute_body([
        ['retractall', ['sensor', 'temp', Unbound('_')]],
        ['assert', ['sensor', 'temp', 35]],
    ])
    db.ephemeral('sensor_update', 'sensor', ['temp', 35])
    assert len(log) == 1

    temp = db.query('sensor', ['temp', None])
    assert temp[0][1] == 35

def test_ephemeral_event():
    db = fresh()
    alerts = []
    db.add_react('alert', lambda et, pred, fact, db: (
        alerts.append(fact),
        db.send('sms', {'msg': 'alert: %s' % fact}),
    ))
    db.ephemeral('alert', 'system', ['overheat', 95])
    assert len(alerts) == 1
    sends = db.collect_sends()
    assert len(sends) == 1
    assert sends[0]['target'] == 'sms'

test("step 7: react rule", test_react)
test("step 7: ephemeral + send", test_ephemeral_event)

# ── Step 8: Prolog text loading ──────────────────────────────

def test_full_program():
    db = fresh()
    count = load_program(db, """
        % Family database
        parent(tom, bob).
        parent(tom, liz).
        parent(bob, ann).
        parent(bob, pat).

        % Rules
        grandparent(X, Y) :- parent(X, Z), parent(Z, Y).
        sibling(X, Y) :- parent(P, X), parent(P, Y).
    """)
    assert count == 6, "expected 6 clauses, got %d" % count

    gps = db.resolve('grandparent', [Unbound('X'), Unbound('Y')])
    assert len(gps) >= 2
    assert any(r['X'] == 'tom' for r in gps)

test("step 8: full program from text", test_full_program)

# ── Summary ──────────────────────────────────────────────────

print("\n  %d tests: %d passed, %d failed\n" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
