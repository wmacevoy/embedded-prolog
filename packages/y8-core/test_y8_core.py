#!/usr/bin/env python3
"""Tests for y8-core: libbf-backed interval projection and comparison."""

import sys
import os
import math

sys.path.insert(0, os.path.dirname(__file__))
from y8_core import project, cmp, decimal_cmp

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


# ── Projection ──────────────────────────────────────────

def test_exact_int():
    lo, hi = project("42")
    assert lo == 42.0 and hi == 42.0, f"got {lo}, {hi}"

def test_exact_decimal():
    lo, hi = project("67432.50")
    assert lo == 67432.5 and hi == 67432.5

def test_inexact():
    lo, hi = project("0.1")
    assert lo < hi, f"expected lo < hi, got {lo} {hi}"
    assert lo <= 0.1 <= hi
    assert math.nextafter(lo, math.inf) == hi, "should be 1-ULP"

def test_large_int():
    lo, hi = project("9007199254740993")
    assert lo < hi, "2^53+1 is not exact"
    assert lo == 9007199254740992.0

def test_overflow():
    lo, hi = project("2e308")
    assert lo == sys.float_info.max
    assert hi == float("inf")

def test_neg_overflow():
    lo, hi = project("-2e308")
    assert lo == float("-inf")
    assert hi == -sys.float_info.max

def test_underflow():
    lo, hi = project("5e-325")
    assert lo == 0.0
    assert hi > 0.0

def test_zero():
    lo, hi = project("0")
    assert lo == 0.0 and hi == 0.0

def test_negative():
    lo, hi = project("-0.1")
    assert lo < hi
    assert lo < 0 and hi < 0


# ── Comparison (y8_cmp) ──────────────────────────────────

def test_cmp_equal():
    assert cmp(42.0, 42.0, None, 42.0, 42.0, None) == 0

def test_cmp_less():
    assert cmp(42.0, 42.0, None, 43.0, 43.0, None) == -1

def test_cmp_greater():
    assert cmp(43.0, 43.0, None, 42.0, 42.0, None) == 1

def test_cmp_overlap():
    """Two non-exact values sharing the same interval."""
    lo1, hi1 = project("0.1")
    lo2, hi2 = project("0.10000000000000000001")
    r = cmp(lo1, hi1, "0.1", lo2, hi2, "0.10000000000000000001")
    assert r == -1, f"0.1 < 0.10000000000000000001, got {r}"


# ── Decimal comparison ───────────────────────────────────

def test_decimal_equal():
    assert decimal_cmp("42", "42") == 0

def test_decimal_equal_trailing():
    assert decimal_cmp("42.0", "42") == 0

def test_decimal_less():
    assert decimal_cmp("0.1", "0.2") == -1

def test_decimal_greater():
    assert decimal_cmp("0.2", "0.1") == 1

def test_decimal_large():
    assert decimal_cmp("9007199254740992", "9007199254740993") == -1

def test_decimal_negative():
    assert decimal_cmp("-2", "-1") == -1

def test_decimal_same_interval():
    """Values that map to the same double but differ in exact representation."""
    assert decimal_cmp("0.1", "0.10000000000000000001") == -1


# ── Trichotomy ───────────────────────────────────────────

def test_trichotomy():
    pairs = [
        ("42", "42"), ("42", "43"), ("0.1", "0.3"),
        ("0.1", "0.10000000000000000001"),
        ("9007199254740992", "9007199254740993"),
        ("-0.1", "0.1"), ("1e308", "2e308"),
    ]
    for a, b in pairs:
        la, ha = project(a)
        lb, hb = project(b)
        sa = a if la != ha else None
        sb = b if lb != hb else None
        lt = cmp(la, ha, sa, lb, hb, sb) < 0
        eq = cmp(la, ha, sa, lb, hb, sb) == 0
        gt = cmp(la, ha, sa, lb, hb, sb) > 0
        total = int(lt) + int(eq) + int(gt)
        assert total == 1, f"trichotomy failed for {a} vs {b}: lt={lt} eq={eq} gt={gt}"


# ── Run ──────────────────────────────────────────────────

print("y8-core (libbf)")

test("project exact int", test_exact_int)
test("project exact decimal", test_exact_decimal)
test("project inexact", test_inexact)
test("project large int", test_large_int)
test("project overflow", test_overflow)
test("project neg overflow", test_neg_overflow)
test("project underflow", test_underflow)
test("project zero", test_zero)
test("project negative", test_negative)
test("cmp equal", test_cmp_equal)
test("cmp less", test_cmp_less)
test("cmp greater", test_cmp_greater)
test("cmp overlap", test_cmp_overlap)
test("decimal equal", test_decimal_equal)
test("decimal equal trailing zeros", test_decimal_equal_trailing)
test("decimal less", test_decimal_less)
test("decimal greater", test_decimal_greater)
test("decimal large", test_decimal_large)
test("decimal negative", test_decimal_negative)
test("decimal same interval", test_decimal_same_interval)
test("trichotomy", test_trichotomy)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
