#!/usr/bin/env python3
# ============================================================
# test_persist.py — Tests for SQLite persistence
#
# Run:  python3 src/test_persist.py
# ============================================================

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from prolog import Engine, atom, var, compound, num, deep_walk
from persist import persist

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


def with_db(fn):
    """Run fn(path) with a temp DB file, cleaned up after."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        fn(path)
    finally:
        os.unlink(path)
        # Clean up WAL/SHM files if present
        for ext in ("-wal", "-shm"):
            try:
                os.unlink(path + ext)
            except OSError:
                pass


# ── Tests ────────────────────────────────────────────────────

def test_survive_restart():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.query_first(compound("assert", [compound("color", [atom("sky"), atom("blue")])]))
        e1.query_first(compound("assert", [compound("color", [atom("grass"), atom("green")])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("color", [var("X"), var("Y")]))
        assert len(results) == 2, "expected 2 facts, got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_retract():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.query_first(compound("assert", [compound("x", [num(1)])]))
        e1.query_first(compound("assert", [compound("x", [num(2)])]))
        e1.query_first(compound("retract", [compound("x", [num(1)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("x", [var("N")]))
        assert len(results) == 1, "expected 1, got %d" % len(results)
        assert results[0] == ("compound", "x", (("num", 2),))
        db2["close"]()
    with_db(run)


def test_retractall():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.query_first(compound("assert", [compound("t", [num(1)])]))
        e1.query_first(compound("assert", [compound("t", [num(2)])]))
        e1.query_first(compound("assert", [compound("t", [num(3)])]))
        e1.query_first(compound("retractall", [compound("t", [var("_")])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("t", [var("N")]))
        assert len(results) == 0, "expected 0, got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_predicates_filter():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path, predicates={"keep/1"})
        e1.query_first(compound("assert", [compound("keep", [num(1)])]))
        e1.query_first(compound("assert", [compound("skip", [num(2)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path, predicates={"keep/1"})
        keep = e2.query(compound("keep", [var("N")]))
        skip = e2.query(compound("skip", [var("N")]))
        assert len(keep) == 1, "expected 1 keep, got %d" % len(keep)
        assert len(skip) == 0, "expected 0 skip, got %d" % len(skip)
        db2["close"]()
    with_db(run)


def test_dedup():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.query_first(compound("assert", [compound("x", [num(1)])]))
        e1.query_first(compound("assert", [compound("x", [num(1)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("x", [var("N")]))
        assert len(results) == 1, "expected 1 (deduped), got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_retract_pattern():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.query_first(compound("assert", [compound("kv", [atom("a"), num(1)])]))
        e1.query_first(compound("assert", [compound("kv", [atom("b"), num(2)])]))
        e1.query_first(compound("retract", [compound("kv", [atom("a"), var("_")])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("kv", [var("K"), var("V")]))
        assert len(results) == 1, "expected 1, got %d" % len(results)
        assert results[0][2][0] == ("atom", "b")
        db2["close"]()
    with_db(run)


def test_memory_db():
    e = Engine()
    db = persist(e, ":memory:")
    e.query_first(compound("assert", [compound("x", [num(42)])]))
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 1
    db["close"]()


def test_update_pattern():
    """retractall + assert = update, persisted correctly."""
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(20)])]))
        # Update: retractall old, assert new
        e1.query_first(compound("retractall", [compound("temp", [atom("kitchen"), var("_")])]))
        e1.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(22)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("temp", [atom("kitchen"), var("T")]))
        assert len(results) == 1, "expected 1, got %d" % len(results)
        assert results[0][2][1] == ("num", 22), "expected 22"
        db2["close"]()
    with_db(run)


def test_ephemeral_transaction():
    """Mutations inside ephemeral commit atomically."""
    def run(path):
        e1 = Engine()

        # Register ephemeral/1 (same as reactive-prolog.js pattern)
        def _ephemeral(goal, rest, subst, depth, on_sol):
            term = deep_walk(goal[2][0], subst)
            e1.clauses.append((term, []))
            try:
                e1._solve(rest, subst, depth + 1, on_sol)
            finally:
                e1.retract_first(term)
        e1.builtins["ephemeral/1"] = _ephemeral

        db1 = persist(e1, path)

        # Seed an initial reading
        e1.query_first(compound("assert", [compound("reading", [atom("s1"), num(20)])]))

        # react rule: retractall old reading, assert new one
        e1.add_clause(
            atom("react"),
            [
                compound("signal", [var("_From"), compound("reading", [var("S"), var("V")])]),
                compound("retractall", [compound("reading", [var("S"), var("_Old")])]),
                compound("assert", [compound("reading", [var("S"), var("V")])]),
            ]
        )
        e1.add_clause(
            compound("handle_signal", [var("From"), var("Fact")]),
            [
                compound("ephemeral", [compound("signal", [var("From"), var("Fact")])]),
                atom("react"),
            ]
        )

        # Process a signal — retractall(reading(s1,_)) + assert(reading(s1,25))
        e1.query_first(compound("handle_signal",
            [atom("s1"), compound("reading", [atom("s1"), num(25)])]))
        db1["close"]()

        # New engine — reading should be updated
        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("reading", [atom("s1"), var("V")]))
        assert len(results) == 1, "expected 1, got %d" % len(results)
        assert results[0][2][1] == ("num", 25), "expected 25"
        db2["close"]()
    with_db(run)


def test_add_clause_persists():
    """Programmatic add_clause (not just assert/1) persists facts."""
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.add_clause(compound("sensor", [atom("s1"), atom("online")]))
        e1.add_clause(compound("sensor", [atom("s2"), atom("offline")]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        results = e2.query(compound("sensor", [var("Id"), var("Status")]))
        assert len(results) == 2, "expected 2, got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_add_clause_skips_rules():
    """add_clause with body (rules) should not be persisted."""
    def run(path):
        e1 = Engine()
        db1 = persist(e1, path)
        e1.add_clause(compound("x", [num(1)]))  # fact — should persist
        e1.add_clause(
            compound("double", [var("X"), var("Y")]),
            [compound("is", [var("Y"), compound("*", [var("X"), num(2)])])]
        )  # rule — should NOT persist
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, path)
        facts = e2.query(compound("x", [var("N")]))
        assert len(facts) == 1, "expected 1 fact, got %d" % len(facts)
        # rule should not be restored
        assert len(e2.clauses) == 1, "expected 1 clause, got %d" % len(e2.clauses)
        db2["close"]()
    with_db(run)


# ── Run ──────────────────────────────────────────────────────

print("persist.py")
test("facts survive restart", test_survive_restart)
test("retract removes from DB", test_retract)
test("retractall clears from DB", test_retractall)
test("predicates filter", test_predicates_filter)
test("duplicate assert dedup", test_dedup)
test("retract with pattern", test_retract_pattern)
test(":memory: database", test_memory_db)
test("retractall + assert update", test_update_pattern)
test("ephemeral = transaction", test_ephemeral_transaction)
test("add_clause persists facts", test_add_clause_persists)
test("add_clause skips rules", test_add_clause_skips_rules)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
