#!/usr/bin/env python3
# ============================================================
# test_family.py — Family tree example using Y8 Datalog
#
# Demonstrates: facts as sets, rules as Horn clauses, joins,
# transitive closure, ephemeral events, react rules.
#
# Run: python3 examples/family/test_family.py
# ============================================================

import sys, os
_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_dir, '..', '..', 'vendor', 'qjson', 'src'))
sys.path.insert(0, os.path.join(_dir, '..', '..', 'src'))

from y8_datalog import Y8Datalog
from y8_loader import load_program
from qjson import Unbound
import sqlite3

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


def build_family():
    conn = sqlite3.connect(':memory:')
    db = Y8Datalog(conn)
    db.setup()

    load_program(db, """
        parent(alice, bob).
        parent(alice, carol).
        parent(bob, dave).
        parent(bob, eve).
        parent(carol, frank).
        sibling(bob, carol).
        sibling(carol, bob).
        male(bob).
        male(dave).
        male(frank).
        female(alice).
        female(carol).
        female(eve).
    """)

    load_program(db, """
        grandparent(GP, GC) :- parent(GP, Y), parent(Y, GC).
        uncle(U, N) :- sibling(U, P), parent(P, N).
        ancestor(X, Y) :- parent(X, Y).
        ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    """)

    return db


print("\n  Family Tree — Y8 Datalog Example\n")

# ── Fact queries ─────────────────────────────────────────────

def test_all_parents():
    db = build_family()
    results = db.query('parent')
    assert len(results) == 5, "expected 5, got %d" % len(results)

def test_parent_of_bob():
    db = build_family()
    results = db.query('parent', [None, 'bob'])
    assert len(results) == 1
    assert results[0][0] == 'alice'

def test_children_of_bob():
    db = build_family()
    results = db.query('parent', ['bob', None])
    assert len(results) == 2
    kids = sorted([r[1] for r in results])
    assert kids == ['dave', 'eve'], "got %s" % kids

test("all parents", test_all_parents)
test("parent of bob", test_parent_of_bob)
test("children of bob", test_children_of_bob)

# ── Rule resolution (joins) ─────────────────────────────────

def test_grandparents():
    db = build_family()
    results = db.resolve('grandparent', [Unbound('GP'), Unbound('GC')])
    gps = [(r['GP'], r['GC']) for r in results]
    assert ('alice', 'dave') in gps, "alice→dave missing from %s" % gps
    assert ('alice', 'eve') in gps, "alice→eve missing"
    assert ('alice', 'frank') in gps, "alice→frank missing"

def test_grandchildren_of_alice():
    db = build_family()
    results = db.resolve('grandparent', ['alice', Unbound('GC')])
    gcs = sorted([r['GC'] for r in results])
    assert 'dave' in gcs
    assert 'eve' in gcs
    assert 'frank' in gcs

def test_uncle():
    db = build_family()
    results = db.resolve('uncle', [Unbound('U'), Unbound('N')])
    pairs = [(r['U'], r['N']) for r in results]
    assert any(u == 'bob' and n == 'frank' for u, n in pairs), \
        "bob→frank missing from %s" % pairs

test("grandparents", test_grandparents)
test("grandchildren of alice", test_grandchildren_of_alice)
test("uncle", test_uncle)

# ── Recursive rules (transitive closure) ─────────────────────

def test_descendants_of_alice():
    db = build_family()
    results = db.resolve('ancestor', ['alice', Unbound('Y')])
    desc = sorted([r['Y'] for r in results])
    for name in ['bob', 'carol', 'dave', 'eve', 'frank']:
        assert name in desc, "%s missing from descendants: %s" % (name, desc)

def test_ancestors_of_dave():
    db = build_family()
    results = db.resolve('ancestor', [Unbound('X'), 'dave'])
    anc = sorted([r['X'] for r in results])
    assert 'bob' in anc, "bob missing from ancestors: %s" % anc
    assert 'alice' in anc, "alice missing from ancestors: %s" % anc

test("descendants of alice (recursive)", test_descendants_of_alice)
test("ancestors of dave (recursive)", test_ancestors_of_dave)

# ── Assert/retract ───────────────────────────────────────────

def test_add_parent():
    db = build_family()
    db.assert_fact('parent', ['eve', 'grace'])
    results = db.query('parent', ['eve', None])
    assert len(results) == 1
    assert results[0][1] == 'grace'

def test_retract_parent():
    db = build_family()
    before = len(db.query('parent'))
    db.retract('parent', ['carol', 'frank'])
    after = len(db.query('parent'))
    assert after == before - 1

test("add parent dynamically", test_add_parent)
test("retract parent", test_retract_parent)

# ── React + ephemeral ────────────────────────────────────────

def test_react_callback():
    db = build_family()
    events = []
    db.add_react('assert', lambda et, pred, fact, db: events.append((pred, fact)))
    db.assert_fact('parent', ['bob', 'grace'])
    assert len(events) == 1
    assert events[0] == ('parent', ['bob', 'grace'])

def test_ephemeral_birth():
    db = build_family()
    births = []
    def on_birth(et, pred, fact, db):
        births.append(fact)
        db.assert_fact('parent', [fact[0], fact[1]])
    db.add_react('birth', on_birth)
    db.ephemeral('birth', 'family', ['eve', 'grace'])
    assert len(births) == 1
    results = db.query('parent', ['eve', None])
    assert any(r[1] == 'grace' for r in results)

def test_send_notification():
    db = build_family()
    def on_birth(et, pred, fact, db):
        db.send('notify', {'event': 'birth', 'parent': fact[0], 'child': fact[1]})
    db.add_react('birth', on_birth)
    db.ephemeral('birth', 'family', ['eve', 'grace'])
    sends = db.collect_sends()
    assert len(sends) == 1
    assert sends[0]['target'] == 'notify'
    assert sends[0]['message']['child'] == 'grace'

test("react callback", test_react_callback)
test("ephemeral birth event", test_ephemeral_birth)
test("send notification", test_send_notification)

# ── Summary ──────────────────────────────────────────────────

print("\n  %d tests: %d passed, %d failed\n" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
