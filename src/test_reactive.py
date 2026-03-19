#!/usr/bin/env python3
"""Tests for Python reactive model: objects, ephemeral, react, native."""

import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from prolog import Engine, atom, var, compound, num, obj, deep_walk, unify, term_to_str

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


# ── Object terms ────────────────────────────────────────

def test_obj_create():
    o = obj([("user", atom("alice")), ("age", num(30))])
    assert o[0] == "object"
    assert len(o[1]) == 2
    assert o[1][0] == ("user", ("atom", "alice"))

def test_obj_unify_exact():
    a = obj([("user", atom("alice"))])
    b = obj([("user", atom("alice"))])
    s = unify(a, b, {})
    assert s is not None

def test_obj_unify_variable():
    a = obj([("user", var("X"))])
    b = obj([("user", atom("alice"))])
    s = unify(a, b, {})
    assert s is not None
    assert s["X"] == ("atom", "alice")

def test_obj_unify_subset():
    pattern = obj([("user", var("Name"))])
    data = obj([("user", atom("alice")), ("age", num(30))])
    s = unify(pattern, data, {})
    assert s is not None
    assert s["Name"] == ("atom", "alice")

def test_obj_unify_symmetric():
    a = obj([("user", var("Name"))])
    b = obj([("user", atom("alice")), ("age", num(30))])
    s1 = unify(a, b, {})
    s2 = unify(b, a, {})
    assert s1 is not None and s2 is not None

def test_obj_unify_fail():
    a = obj([("user", atom("alice"))])
    b = obj([("user", atom("bob"))])
    s = unify(a, b, {})
    assert s is None

def test_obj_deep_walk():
    o = obj([("x", var("V"))])
    walked = deep_walk(o, {"V": num(42)})
    assert walked[1][0] == ("x", ("num", 42))

def test_obj_to_str():
    o = obj([("user", atom("alice")), ("age", num(30))])
    s = term_to_str(o)
    assert s == "{user:alice,age:30}"

def test_obj_in_compound():
    t = compound("react", [obj([("type", atom("signal"))])])
    s = term_to_str(t)
    assert "react({type:signal})" == s


# ── Reactive model ──────────────────────────────────────

def test_react_assert():
    e = Engine()
    e.add_clause(
        compound("react", [compound("assert", [var("F")])]),
        [compound("send", [atom("log"), var("F")])]
    )
    e._sends = []
    e.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(22)])]))
    assert len(e._sends) > 0
    assert e._sends[0][1][1] == "temp"  # functor of the fact

def test_react_retract():
    e = Engine()
    e.add_clause(compound("temp", [atom("kitchen"), num(22)]))
    e.add_clause(
        compound("react", [compound("retract", [var("F")])]),
        [compound("send", [atom("log"), var("F")])]
    )
    e._sends = []
    e.query_first(compound("retract", [compound("temp", [atom("kitchen"), num(22)])]))
    assert len(e._sends) > 0

def test_ephemeral():
    e = Engine()
    e.add_clause(
        compound("react", [obj([("type", atom("signal")), ("value", var("V"))])]),
        [compound("send", [atom("out"), var("V")])]
    )
    clauses_before = len(e.clauses)
    e._sends = []
    e.query_first(compound("ephemeral", [
        obj([("type", atom("signal")), ("value", num(42))])
    ]))
    assert len(e.clauses) == clauses_before, "no clauses added"
    assert len(e._sends) > 0
    assert e._sends[0][1] == ("num", 42)

def test_ephemeral_untrusted():
    e = Engine()
    e.add_clause(compound("trusted", [atom("sensor1")]))
    e.add_clause(
        compound("react", [obj([("type", atom("signal")), ("from", var("F")), ("value", var("V"))])]),
        [compound("trusted", [var("F")]), compound("send", [atom("out"), var("V")])]
    )
    e._sends = []
    e.query_first(compound("ephemeral", [
        obj([("type", atom("signal")), ("from", atom("hacker")), ("value", num(99))])
    ]))
    assert len(e._sends) == 0, "untrusted should produce no sends"

def test_ephemeral_chain():
    e = Engine()
    e.add_clause(
        compound("react", [obj([("type", atom("signal")), ("value", var("V"))])]),
        [compound("ephemeral", [obj([("type", atom("processed")), ("result", var("V"))])])]
    )
    e.add_clause(
        compound("react", [obj([("type", atom("processed")), ("result", var("R"))])]),
        [compound("send", [atom("out"), var("R")])]
    )
    e._sends = []
    e.query_first(compound("ephemeral", [
        obj([("type", atom("signal")), ("value", num(42))])
    ]))
    assert len(e._sends) > 0
    assert e._sends[0][1] == ("num", 42)

def test_native():
    e = Engine()
    e.register_native("double", lambda args: num(args[0][1] * 2))
    e.add_clause(
        compound("test", [var("X"), var("Y")]),
        [compound("native", [compound("double", [var("X")]), var("Y")])]
    )
    result = e.query_first(compound("test", [num(21), var("Y")]))
    assert result is not None
    assert result[2][1] == ("num", 42)

def test_native_in_react():
    log = []
    e = Engine()
    e.register_native("log_insert", lambda args: (log.append(args[0]), atom("ok"))[1])
    e.add_clause(
        compound("react", [compound("assert", [var("F")])]),
        [compound("native", [compound("log_insert", [var("F")]), var("_Ok")])]
    )
    e.query_first(compound("assert", [compound("temp", [atom("kitchen"), num(22)])]))
    assert len(log) == 1
    assert log[0][1] == "temp"

def test_assert_inside_react():
    e = Engine()
    e.add_clause(
        compound("react", [obj([("type", atom("signal")), ("value", var("V"))])]),
        [compound("assert", [compound("reading", [var("V")])])]
    )
    e.add_clause(
        compound("react", [compound("assert", [compound("reading", [var("V")])])]),
        [compound("send", [atom("persisted"), var("V")])]
    )
    e._sends = []
    e.query_first(compound("ephemeral", [
        obj([("type", atom("signal")), ("value", num(42))])
    ]))
    results = e.query(compound("reading", [var("V")]))
    assert len(results) == 1
    assert len(e._sends) > 0


# ── Run ──────────────────────────────────────────────────

print("Python reactive model")

test("object create", test_obj_create)
test("object unify exact", test_obj_unify_exact)
test("object unify variable", test_obj_unify_variable)
test("object unify subset", test_obj_unify_subset)
test("object unify symmetric", test_obj_unify_symmetric)
test("object unify fail", test_obj_unify_fail)
test("object deep_walk", test_obj_deep_walk)
test("object term_to_str", test_obj_to_str)
test("object in compound", test_obj_in_compound)
test("react(assert(F)) fires", test_react_assert)
test("react(retract(F)) fires", test_react_retract)
test("ephemeral fires react", test_ephemeral)
test("ephemeral untrusted rejected", test_ephemeral_untrusted)
test("ephemeral chain", test_ephemeral_chain)
test("native/2 calls function", test_native)
test("native/2 in react rule", test_native_in_react)
test("assert inside react cascades", test_assert_inside_react)

print("\n%d tests: %d passed, %d failed" % (passed + failed, passed, failed))
if failed:
    sys.exit(1)
