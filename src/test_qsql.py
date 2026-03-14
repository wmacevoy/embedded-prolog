#!/usr/bin/env python3
# ============================================================
# test_qsql.py — Tests for QSQL per-predicate typed adapter
#
# Run:  python3 src/test_qsql.py
# ============================================================

import os
import sys
import tempfile
import sqlite3

sys.path.insert(0, os.path.dirname(__file__))
from prolog import Engine, atom, var, compound, num, deep_walk
from persist import persist
from qsql import qsql_adapter, _table_name, _arg_val, _safe_name

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
        for ext in ("-wal", "-shm"):
            try:
                os.unlink(path + ext)
            except OSError:
                pass


# ── Unit tests: helpers ──────────────────────────────────────

def test_safe_name():
    assert _safe_name("price") == "price"
    assert _safe_name("my-pred") == "my_pred"
    assert _safe_name("a.b.c") == "a_b_c"
    assert _safe_name("ok_123") == "ok_123"

def test_table_name():
    assert _table_name("price", 2) == "q$price$2"
    assert _table_name("color", 0) == "q$color$0"
    assert _table_name("my-pred", 1) == "q$my_pred$1"

def test_arg_val():
    assert _arg_val({"t": "a", "n": "hello"}) == "hello"
    assert _arg_val({"t": "n", "v": 42}) == 42
    assert _arg_val({"t": "n", "v": 3.14}) == 3.14
    assert _arg_val(None) is None
    # compound → JSON string
    val = _arg_val({"t": "c", "f": "pair", "a": [{"t": "n", "v": 1}]})
    assert isinstance(val, str)
    assert "pair" in val

# ── Integration tests: through persist ────────────────────────

def test_facts_survive_restart():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("color", [atom("sky"), atom("blue")])]))
        e1.query_first(compound("assert", [compound("color", [atom("grass"), atom("green")])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        results = e2.query(compound("color", [var("X"), var("Y")]))
        assert len(results) == 2, "expected 2, got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_retract():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("x", [num(1)])]))
        e1.query_first(compound("assert", [compound("x", [num(2)])]))
        e1.query_first(compound("retract", [compound("x", [num(1)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        results = e2.query(compound("x", [var("N")]))
        assert len(results) == 1, "expected 1, got %d" % len(results)
        assert results[0] == ("compound", "x", (("num", 2),))
        db2["close"]()
    with_db(run)


def test_retractall():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("t", [num(1)])]))
        e1.query_first(compound("assert", [compound("t", [num(2)])]))
        e1.query_first(compound("assert", [compound("t", [num(3)])]))
        e1.query_first(compound("retractall", [compound("t", [var("_")])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        results = e2.query(compound("t", [var("N")]))
        assert len(results) == 0, "expected 0, got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_predicates_filter():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path), predicates={"keep/1"})
        e1.query_first(compound("assert", [compound("keep", [num(1)])]))
        e1.query_first(compound("assert", [compound("skip", [num(2)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path), predicates={"keep/1"})
        keep = e2.query(compound("keep", [var("N")]))
        skip = e2.query(compound("skip", [var("N")]))
        assert len(keep) == 1, "expected 1 keep, got %d" % len(keep)
        assert len(skip) == 0, "expected 0 skip, got %d" % len(skip)
        db2["close"]()
    with_db(run)


def test_dedup():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("x", [num(1)])]))
        e1.query_first(compound("assert", [compound("x", [num(1)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        results = e2.query(compound("x", [var("N")]))
        assert len(results) == 1, "expected 1 (deduped), got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_update_pattern():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(20)])]))
        e1.query_first(compound("retractall", [compound("temp", [atom("kitchen"), var("_")])]))
        e1.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(22)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        results = e2.query(compound("temp", [atom("kitchen"), var("T")]))
        assert len(results) == 1, "expected 1, got %d" % len(results)
        assert results[0][2][1] == ("num", 22), "expected 22"
        db2["close"]()
    with_db(run)


def test_add_clause_persists():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.add_clause(compound("sensor", [atom("s1"), atom("online")]))
        e1.add_clause(compound("sensor", [atom("s2"), atom("offline")]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        results = e2.query(compound("sensor", [var("Id"), var("Status")]))
        assert len(results) == 2, "expected 2, got %d" % len(results)
        db2["close"]()
    with_db(run)


def test_add_clause_skips_rules():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.add_clause(compound("x", [num(1)]))
        e1.add_clause(
            compound("double", [var("X"), var("Y")]),
            [compound("is", [var("Y"), compound("*", [var("X"), num(2)])])]
        )
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        facts = e2.query(compound("x", [var("N")]))
        assert len(facts) == 1, "expected 1 fact, got %d" % len(facts)
        assert len(e2.clauses) == 1, "expected 1 clause, got %d" % len(e2.clauses)
        db2["close"]()
    with_db(run)


# ── QSQL-specific tests: schema verification ─────────────────

def test_per_predicate_tables():
    """Each predicate gets its own table."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("color", [atom("red")])]))
        e.query_first(compound("assert", [compound("price", [atom("aapl"), num(187)])]))

        # Verify tables exist
        conn = sqlite3.connect(path)
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        assert "q$color$1" in tables, "missing q$color$1, got: %s" % tables
        assert "q$price$2" in tables, "missing q$price$2, got: %s" % tables
        assert "qsql_meta" in tables, "missing qsql_meta"
        conn.close()
        db["close"]()
    with_db(run)


def test_typed_columns():
    """Arguments stored as native SQLite types."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("price", [atom("aapl"), num(187)])]))

        conn = sqlite3.connect(path)
        row = conn.execute('SELECT arg0, arg1, typeof(arg0), typeof(arg1) '
                           'FROM "q$price$2"').fetchone()
        assert row[0] == "aapl", "arg0 should be 'aapl', got %r" % (row[0],)
        assert row[1] == 187, "arg1 should be 187, got %r" % (row[1],)
        assert row[2] == "text", "arg0 type should be text, got %s" % row[2]
        assert row[3] == "integer", "arg1 type should be integer, got %s" % row[3]
        conn.close()
        db["close"]()
    with_db(run)


def test_float_column():
    """Float numbers stored as REAL."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(22.5)])]))

        conn = sqlite3.connect(path)
        row = conn.execute('SELECT arg1, typeof(arg1) FROM "q$temp$2"').fetchone()
        assert row[0] == 22.5, "arg1 should be 22.5, got %r" % (row[0],)
        assert row[1] == "real", "arg1 type should be real, got %s" % row[1]
        conn.close()
        db["close"]()
    with_db(run)


def test_indexes_created():
    """Indexes created on each arg column."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("kv", [atom("a"), num(1)])]))

        conn = sqlite3.connect(path)
        indexes = [r[1] for r in conn.execute(
            "SELECT * FROM sqlite_master WHERE type='index' AND tbl_name='q$kv$2'"
        ).fetchall()]
        assert "ix$q$kv$2$0" in indexes, "missing index on arg0: %s" % indexes
        assert "ix$q$kv$2$1" in indexes, "missing index on arg1: %s" % indexes
        conn.close()
        db["close"]()
    with_db(run)


def test_meta_table():
    """qsql_meta tracks registered predicates."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("color", [atom("red")])]))
        e.query_first(compound("assert", [compound("price", [atom("aapl"), num(187)])]))

        conn = sqlite3.connect(path)
        metas = conn.execute("SELECT functor, arity FROM qsql_meta ORDER BY functor").fetchall()
        assert len(metas) == 2, "expected 2 meta rows, got %d" % len(metas)
        assert metas[0] == ("color", 1)
        assert metas[1] == ("price", 2)
        conn.close()
        db["close"]()
    with_db(run)


def test_memory_db():
    e = Engine()
    db = persist(e, qsql_adapter(":memory:"))
    e.query_first(compound("assert", [compound("x", [num(42)])]))
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 1
    db["close"]()


def test_multiple_predicates():
    """Multiple predicates with different arities coexist."""
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("a", [num(1)])]))
        e1.query_first(compound("assert", [compound("b", [num(2), num(3)])]))
        e1.query_first(compound("assert", [compound("c", [num(4), num(5), num(6)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        assert len(e2.query(compound("a", [var("X")]))) == 1
        assert len(e2.query(compound("b", [var("X"), var("Y")]))) == 1
        assert len(e2.query(compound("c", [var("X"), var("Y"), var("Z")]))) == 1
        db2["close"]()
    with_db(run)


# ── Run ──────────────────────────────────────────────────────

print("qsql.py")

# Unit tests
test("safe_name", test_safe_name)
test("table_name", test_table_name)
test("arg_val", test_arg_val)

# Persist-compatible tests
test("facts survive restart", test_facts_survive_restart)
test("retract removes from DB", test_retract)
test("retractall clears from DB", test_retractall)
test("predicates filter", test_predicates_filter)
test("duplicate assert dedup", test_dedup)
test("retractall + assert update", test_update_pattern)
test("add_clause persists facts", test_add_clause_persists)
test("add_clause skips rules", test_add_clause_skips_rules)

# QSQL-specific tests
test("per-predicate tables", test_per_predicate_tables)
test("typed columns", test_typed_columns)
test("float column", test_float_column)
test("indexes created", test_indexes_created)
test("meta table", test_meta_table)
test(":memory: database", test_memory_db)
test("multiple predicates", test_multiple_predicates)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
