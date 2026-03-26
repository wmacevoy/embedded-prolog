#!/usr/bin/env python3
# ============================================================
# test_y8_datalog.py — Tests for Y8 Datalog layer
# ============================================================

import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'vendor', 'qjson', 'src'))
sys.path.insert(0, os.path.dirname(__file__))

import sqlite3
from y8_datalog import Y8Datalog
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

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
