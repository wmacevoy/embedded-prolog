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
from qsql import (qsql_adapter, _table_name, _arg_val, _arg_interval,
                   _safe_name, _next_up, _next_down, _rounding_dir)

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

def test_table_name():
    assert _table_name("price", 2) == "q$price$2"
    assert _table_name("color", 0) == "q$color$0"

def test_arg_val():
    assert _arg_val({"t": "a", "n": "hello"}) == "hello"
    assert _arg_val({"t": "n", "v": 42}) == 42
    assert _arg_val({"t": "n", "v": 3.14}) == 3.14
    assert _arg_val(None) is None

# ── Interval tests ───────────────────────────────────────────

def test_next_up():
    u = _next_up(1.0)
    assert u > 1.0, "nextUp(1.0) should be > 1.0"
    assert u - 1.0 < 1e-15, "should be within 1 ULP"

def test_next_down():
    d = _next_down(1.0)
    assert d < 1.0, "nextDown(1.0) should be < 1.0"
    assert 1.0 - d < 1e-15

def test_next_up_negative():
    u = _next_up(-1.0)
    assert u > -1.0
    assert u < 0

def test_next_up_zero():
    assert _next_up(0.0) == 5e-324

def test_next_down_zero():
    assert _next_down(0.0) == -5e-324

def test_next_roundtrip():
    x = 42.5
    assert _next_down(_next_up(x)) == x
    assert _next_up(_next_down(x)) == x

def test_rounding_dir():
    assert _rounding_dir(42.0, "42") == 0, "42 is exact"
    assert _rounding_dir(0.5, "0.5") == 0, "0.5 is exact"
    assert _rounding_dir(67432.5, "67432.50") == 0, "67432.50 is exact"
    assert _rounding_dir(0.1, "0.1") == 1, "0.1 rounds up"
    assert _rounding_dir(0.3, "0.3") == -1, "0.3 rounds down"

def test_rounding_dir_extreme():
    # Overflow
    assert _rounding_dir(float('inf'), "2e308") == 1, "inf > finite"
    assert _rounding_dir(float('-inf'), "-2e308") == -1, "-inf < finite"
    # Underflow
    assert _rounding_dir(0.0, "5e-325") == -1, "0 < positive tiny"
    assert _rounding_dir(0.0, "-5e-325") == 1, "0 > negative tiny"
    assert _rounding_dir(0.0, "0") == 0, "0 == 0"
    # Very large: 1e21 is exact (5^21 < 2^53)
    assert _rounding_dir(1e21, "1000000000000000000000") == 0, "1e21 exact"
    # 1e25 is NOT exact (5^25 > 2^53) → double rounds up
    assert _rounding_dir(1e25, "10000000000000000000000000") == 1, "1e25 rounds up"
    # Very small: 2^-20 is exact (negative power of 2)
    assert _rounding_dir(2**-20, "0.00000095367431640625") == 0, "2^-20 exact"
    # 1e-10 is NOT exact → rounds up
    assert _rounding_dir(1e-10, "0.0000000001") == 1, "1e-10 rounds up"

def test_interval_atom():
    iv = _arg_interval({"t": "a", "n": "btc"})
    assert iv == ("btc", None, None)

def test_interval_plain_num():
    iv = _arg_interval({"t": "n", "v": 42})
    assert len(iv) == 3, "3 elements"
    assert iv[0] == "42", "val is string"
    assert iv[1] == 42.0 and iv[2] == 42.0, "point interval"

def test_interval_exact_bigdecimal():
    # 67432.50 is exactly representable → point interval
    iv = _arg_interval({"t": "n", "v": 67432.5, "r": "67432.50M"})
    assert iv[0] == "67432.50", "val = raw digits"
    assert iv[1] == 67432.5, "lo = exact"
    assert iv[2] == 67432.5, "hi = exact"

def test_interval_exact_bigint():
    # 42 is exactly representable → point interval
    iv = _arg_interval({"t": "n", "v": 42, "r": "42N"})
    assert iv[0] == "42", "val = raw digits"
    assert iv[1] == 42.0, "lo = exact"
    assert iv[2] == 42.0, "hi = exact"

def test_interval_inexact():
    # 0.1 is NOT exact — double rounds UP → lo = nextDown, hi = double
    iv = _arg_interval({"t": "n", "v": 0.1, "r": "0.1M"})
    assert iv[0] == "0.1", "val = raw digits"
    assert iv[1] < 0.1, "lo < double (nextDown)"
    assert iv[2] == 0.1, "hi = double (since v > exact)"

def test_interval_brackets():
    # 0.3 rounds DOWN — double < exact 0.3
    iv = _arg_interval({"t": "n", "v": 0.3, "r": "0.3M"})
    assert iv[0] == "0.3", "val = raw digits"
    assert iv[1] == 0.3, "lo = double (since v < exact)"
    assert iv[2] > 0.3, "hi > double (nextUp)"

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
        assert len(results) == 1
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
        assert len(results) == 0
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
        assert len(results) == 1
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
        assert len(results) == 1
        assert results[0][2][1] == ("num", 22)
        db2["close"]()
    with_db(run)


def test_memory_db():
    e = Engine()
    db = persist(e, qsql_adapter(":memory:"))
    e.query_first(compound("assert", [compound("x", [num(42)])]))
    results = e.query(compound("x", [var("N")]))
    assert len(results) == 1
    db["close"]()


# ── Schema verification ──────────────────────────────────────

def test_per_predicate_tables():
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("color", [atom("red")])]))
        e.query_first(compound("assert", [compound("price", [atom("aapl"), num(187)])]))
        conn = sqlite3.connect(path)
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        assert "q$color$1" in tables
        assert "q$price$2" in tables
        conn.close()
        db["close"]()
    with_db(run)


def test_typed_columns():
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("price", [atom("aapl"), num(187)])]))
        conn = sqlite3.connect(path)
        row = conn.execute('SELECT arg0, arg1, arg1_lo, arg1_hi FROM "q$price$2"').fetchone()
        assert row[0] == "aapl"
        assert row[1] == "187", "val is string"
        assert row[2] == 187.0, "lo == val for plain num"
        assert row[3] == 187.0, "hi == val for plain num"
        conn.close()
        db["close"]()
    with_db(run)


def test_exact_bigdecimal_interval():
    """Exact BigDecimal M values get point interval."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.add_clause(compound("price", [atom("btc"), num(67432.5, "67432.50M")]))
        conn = sqlite3.connect(path)
        row = conn.execute('SELECT arg1, arg1_lo, arg1_hi FROM "q$price$2"').fetchone()
        assert row[0] == "67432.50", "value string"
        assert row[1] == 67432.5, "lo = exact (point)"
        assert row[2] == 67432.5, "hi = exact (point)"
        conn.close()
        db["close"]()
    with_db(run)


def test_inexact_bigdecimal_interval():
    """Inexact BigDecimal M values get 1-ULP interval."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.add_clause(compound("rate", [num(0.1, "0.1M")]))
        conn = sqlite3.connect(path)
        row = conn.execute('SELECT arg0, arg0_lo, arg0_hi FROM "q$rate$1"').fetchone()
        assert row[0] == "0.1", "value string"
        assert row[1] < row[2], "lo < hi (non-point)"
        conn.close()
        db["close"]()
    with_db(run)


def test_atom_null_interval():
    """Atoms have NULL interval columns."""
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.add_clause(compound("tag", [atom("btc")]))
        conn = sqlite3.connect(path)
        row = conn.execute('SELECT arg0, arg0_lo, arg0_hi FROM "q$tag$1"').fetchone()
        assert row[0] == "btc"
        assert row[1] is None
        assert row[2] is None
        conn.close()
        db["close"]()
    with_db(run)


def test_indexes_created():
    def run(path):
        e = Engine()
        db = persist(e, qsql_adapter(path))
        e.query_first(compound("assert", [compound("kv", [atom("a"), num(1)])]))
        conn = sqlite3.connect(path)
        indexes = [r[1] for r in conn.execute(
            "SELECT * FROM sqlite_master WHERE type='index' AND tbl_name='q$kv$2'"
        ).fetchall()]
        assert "ix$q$kv$2$0" in indexes, "index on arg0"
        assert "ix$q$kv$2$0lo" in indexes, "index on arg0_lo"
        assert "ix$q$kv$2$1" in indexes, "index on arg1"
        assert "ix$q$kv$2$1lo" in indexes, "index on arg1_lo"
        conn.close()
        db["close"]()
    with_db(run)


def test_multiple_predicates():
    def run(path):
        e1 = Engine()
        db1 = persist(e1, qsql_adapter(path))
        e1.query_first(compound("assert", [compound("a", [num(1)])]))
        e1.query_first(compound("assert", [compound("b", [num(2), num(3)])]))
        db1["close"]()

        e2 = Engine()
        db2 = persist(e2, qsql_adapter(path))
        assert len(e2.query(compound("a", [var("X")]))) == 1
        assert len(e2.query(compound("b", [var("X"), var("Y")]))) == 1
        db2["close"]()
    with_db(run)


# ── Run ──────────────────────────────────────────────────────

print("qsql.py")

# Unit tests
test("safe_name", test_safe_name)
test("table_name", test_table_name)
test("arg_val", test_arg_val)

# Interval tests
test("nextUp", test_next_up)
test("nextDown", test_next_down)
test("nextUp negative", test_next_up_negative)
test("nextUp zero", test_next_up_zero)
test("nextDown zero", test_next_down_zero)
test("nextUp/nextDown roundtrip", test_next_roundtrip)
test("rounding direction", test_rounding_dir)
test("rounding direction extreme", test_rounding_dir_extreme)
test("interval atom", test_interval_atom)
test("interval plain num", test_interval_plain_num)
test("interval exact BigDecimal", test_interval_exact_bigdecimal)
test("interval exact BigInt", test_interval_exact_bigint)
test("interval inexact", test_interval_inexact)
test("interval brackets value", test_interval_brackets)

# Persist-compatible tests
test("facts survive restart", test_facts_survive_restart)
test("retract removes from DB", test_retract)
test("retractall clears from DB", test_retractall)
test("duplicate assert dedup", test_dedup)
test("retractall + assert update", test_update_pattern)
test(":memory: database", test_memory_db)

# Schema verification
test("per-predicate tables", test_per_predicate_tables)
test("typed columns", test_typed_columns)
test("exact BigDecimal interval stored", test_exact_bigdecimal_interval)
test("inexact BigDecimal interval stored", test_inexact_bigdecimal_interval)
test("atom null interval", test_atom_null_interval)
test("indexes created", test_indexes_created)
test("multiple predicates", test_multiple_predicates)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
