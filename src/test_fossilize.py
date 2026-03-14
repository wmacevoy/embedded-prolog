#!/usr/bin/env python3
# ============================================================
# test_fossilize.py — Tests for fossilize()
# ============================================================

import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from prolog import Engine, atom, var, compound, num, deep_walk
from fossilize import fossilize, mineralize

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


def test_queries_still_work():
    e = Engine()
    e.add_clause(compound("color", [atom("sky"), atom("blue")]))
    e.add_clause(compound("color", [atom("grass"), atom("green")]))
    fossilize(e)
    results = e.query(compound("color", [var("X"), var("Y")]))
    assert len(results) == 2, "expected 2 facts, got %d" % len(results)


def test_rules_still_work():
    e = Engine()
    e.add_clause(compound("parent", [atom("tom"), atom("bob")]))
    e.add_clause(compound("parent", [atom("bob"), atom("ann")]))
    e.add_clause(
        compound("grandparent", [var("X"), var("Z")]),
        [compound("parent", [var("X"), var("Y")]),
         compound("parent", [var("Y"), var("Z")])]
    )
    fossilize(e)
    result = e.query_first(compound("grandparent", [atom("tom"), var("Z")]))
    assert result is not None, "grandparent query should work"
    assert result[2][1] == ("atom", "ann")


def test_assert_blocked():
    e = Engine()
    fossilize(e)
    result = e.query_first(compound("assert", [compound("x", [num(1)])]))
    assert result is None, "assert should fail after fossilize"
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 0, "no facts should exist"


def test_retract_blocked():
    e = Engine()
    e.add_clause(compound("x", [num(1)]))
    fossilize(e)
    result = e.query_first(compound("retract", [compound("x", [num(1)])]))
    assert result is None, "retract should fail after fossilize"
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 1, "fact should still exist"


def test_retractall_blocked():
    e = Engine()
    e.add_clause(compound("x", [num(1)]))
    e.add_clause(compound("x", [num(2)]))
    fossilize(e)
    e.query_first(compound("retractall", [compound("x", [var("_")])]))
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 2, "both facts should survive"


def test_add_clause_blocked():
    e = Engine()
    fossilize(e)
    e.add_clause(compound("x", [num(99)]))
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 0, "add_clause should be blocked"


def test_ephemeral_works():
    """ephemeral/1 still functions after fossilize."""
    e = Engine()

    # Register ephemeral/1
    def _ephemeral(goal, rest, subst, depth, on_sol):
        term = deep_walk(goal[2][0], subst)
        e.clauses.append((term, []))
        try:
            e._solve(rest, subst, depth + 1, on_sol)
        finally:
            e.retract_first(term)
    e.builtins["ephemeral/1"] = _ephemeral

    # Rule: handle_signal asserts ephemeral signal, queries it
    e.add_clause(
        compound("handle", [var("X")]),
        [compound("ephemeral", [compound("sig", [var("X")])]),
         compound("sig", [var("X")])]
    )
    fossilize(e)

    result = e.query_first(compound("handle", [atom("hello")]))
    assert result is not None, "ephemeral query should succeed"
    # Signal should be auto-retracted
    sig = e.query_first(compound("sig", [var("X")]))
    assert sig is None, "ephemeral fact should be gone"


def test_ephemeral_doesnt_leak():
    """Ephemeral facts don't accumulate in fossilized engine."""
    e = Engine()

    def _ephemeral(goal, rest, subst, depth, on_sol):
        term = deep_walk(goal[2][0], subst)
        e.clauses.append((term, []))
        try:
            e._solve(rest, subst, depth + 1, on_sol)
        finally:
            e.retract_first(term)
    e.builtins["ephemeral/1"] = _ephemeral

    e.add_clause(atom("react"), [compound("sig", [var("X")])])
    e.add_clause(
        compound("handle", [var("X")]),
        [compound("ephemeral", [compound("sig", [var("X")])]),
         atom("react")]
    )
    boundary = fossilize(e)

    # Process 100 signals
    for i in range(100):
        e.query_first(compound("handle", [num(i)]))

    # No clause leak beyond the fossil boundary
    assert len(e.clauses) == boundary, \
        "expected %d clauses, got %d" % (boundary, len(e.clauses))


def test_injection_attempt():
    """Malicious Prolog can't modify the knowledge base."""
    e = Engine()
    e.add_clause(compound("trusted", [atom("sensor_1")]))
    e.add_clause(
        compound("check", [var("X")]),
        [compound("trusted", [var("X")])]
    )
    fossilize(e)

    # Attempt injection: try to assert trusted(evil)
    e.query_first(compound("assert", [compound("trusted", [atom("evil")])]))

    # evil should NOT be trusted
    result = e.query_first(compound("check", [atom("evil")]))
    assert result is None, "injection should have failed"

    # sensor_1 should still be trusted
    result = e.query_first(compound("check", [atom("sensor_1")]))
    assert result is not None, "original trust should remain"


# ── Run ──────────────────────────────────────────────────────

print("fossilize.py")
test("queries still work", test_queries_still_work)
test("rules still work", test_rules_still_work)
test("assert/1 blocked", test_assert_blocked)
test("retract/1 blocked", test_retract_blocked)
test("retractall/1 blocked", test_retractall_blocked)
test("addClause blocked", test_add_clause_blocked)
test("ephemeral still works", test_ephemeral_works)
test("ephemeral doesn't leak", test_ephemeral_doesnt_leak)
test("injection attempt fails", test_injection_attempt)

# ── mineralize tests ─────────────────────────────────────────

def test_mineralize_blocks_assert():
    e = Engine()
    e.add_clause(compound("threshold", [atom("btc"), num(70000)]))
    mineralize(e, "threshold", 2)
    e.query_first(compound("assert", [compound("threshold", [atom("eth"), num(4000)])]))
    results = e.query(compound("threshold", [var("S"), var("L")]))
    assert len(results) == 1, "only original, got %d" % len(results)

def test_mineralize_blocks_retract():
    e = Engine()
    e.add_clause(compound("threshold", [atom("btc"), num(70000)]))
    mineralize(e, "threshold", 2)
    e.query_first(compound("retract", [compound("threshold", [atom("btc"), num(70000)])]))
    results = e.query(compound("threshold", [var("S"), var("L")]))
    assert len(results) == 1, "threshold survives retract"

def test_mineralize_allows_unlocked():
    e = Engine()
    e.add_clause(compound("threshold", [atom("btc"), num(70000)]))
    mineralize(e, "threshold", 2)
    e.query_first(compound("assert", [compound("price", [atom("btc"), num(65000)])]))
    prices = e.query(compound("price", [var("S"), var("P")]))
    assert len(prices) == 1, "price should be asserted"
    e.query_first(compound("retractall", [compound("price", [var("_S"), var("_P")])]))
    prices = e.query(compound("price", [var("S"), var("P")]))
    assert len(prices) == 0, "price should be retracted"

def test_mineralize_blocks_add_clause():
    e = Engine()
    mineralize(e, "react", 0)
    e.add_clause(atom("react"), [atom("something")])
    assert len(e.clauses) == 0, "add_clause blocked"

def test_mineralize_multiple():
    e = Engine()
    e.add_clause(compound("rule_a", [num(1)]))
    e.add_clause(compound("data_c", [num(3)]))
    mineralize(e, "rule_a", 1)
    e.query_first(compound("assert", [compound("rule_a", [num(99)])]))
    e.query_first(compound("assert", [compound("data_c", [num(99)])]))
    assert len(e.query(compound("rule_a", [var("N")]))) == 1, "rule_a locked"
    assert len(e.query(compound("data_c", [var("N")]))) == 2, "data_c open"

def test_mineralize_one_way():
    e = Engine()
    e.add_clause(compound("x", [num(1)]))
    mineralize(e, "x", 1)
    assert e.mineralized.get("x/1") == True
    e.query_first(compound("assert", [compound("x", [num(2)])]))
    assert len(e.query(compound("x", [var("N")]))) == 1, "still locked"

def test_mineralize_then_fossilize():
    e = Engine()
    e.add_clause(compound("rule", [num(1)]))
    e.add_clause(compound("data", [num(2)]))
    mineralize(e, "rule", 1)
    e.query_first(compound("assert", [compound("data", [num(3)])]))
    assert len(e.query(compound("data", [var("N")]))) == 2, "data open"
    fossilize(e)
    e.query_first(compound("assert", [compound("data", [num(4)])]))
    assert len(e.query(compound("data", [var("N")]))) == 2, "data locked after fossilize"

test("mineralize blocks assert", test_mineralize_blocks_assert)
test("mineralize blocks retract", test_mineralize_blocks_retract)
test("mineralize allows unlocked", test_mineralize_allows_unlocked)
test("mineralize blocks add_clause", test_mineralize_blocks_add_clause)
test("mineralize multiple predicates", test_mineralize_multiple)
test("mineralize is one-way", test_mineralize_one_way)
test("mineralize then fossilize", test_mineralize_then_fossilize)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
