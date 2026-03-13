// ============================================================
// test-tracer.js — Tests for tracer.js
//
// Run with ANY JavaScript runtime:
//   node src/test-tracer.js
//   qjs --module src/test-tracer.js
//   deno run src/test-tracer.js
//
// No node:test.  No npm.  No package.json.  No dependencies.
// ============================================================

// ── print() polyfill ────────────────────────────────────────
var _print = (typeof print !== "undefined" && typeof window === "undefined") ? print : console.log.bind(console);

// ── Minimal test harness ────────────────────────────────────
var _suites = [];
var _current = null;

function describe(name, fn) {
  var s = { name: name, tests: [], pass: 0, fail: 0 };
  _suites.push(s);
  _current = s;
  fn();
  _current = null;
}

function it(name, fn) {
  _current.tests.push({ name: name, fn: fn });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
assert.equal    = function(a, b) { if (a !== b) throw new Error("got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); };
assert.notEqual = function(a, b) { if (a === b) throw new Error("got equal: " + JSON.stringify(a)); };
assert.ok       = function(v, m) { if (!v) throw new Error(m || "not truthy: " + JSON.stringify(v)); };
assert.deepEqual = function(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); };

function runTests() {
  var totalPass = 0, totalFail = 0;
  for (var si = 0; si < _suites.length; si++) {
    var suite = _suites[si];
    _print("  " + suite.name);
    for (var ti = 0; ti < suite.tests.length; ti++) {
      var test = suite.tests[ti];
      try {
        test.fn();
        suite.pass++; totalPass++;
        _print("    PASS " + test.name);
      } catch (e) {
        suite.fail++; totalFail++;
        _print("    FAIL " + test.name);
        _print("      " + (e.message || e));
      }
    }
  }
  _print("\n  " + totalPass + " passing, " + totalFail + " failing\n");
  if (totalFail > 0 && typeof process !== "undefined" && process.exit) process.exit(1);
  return totalFail;
}

// ── Imports ─────────────────────────────────────────────────

import { PrologEngine, termToString } from "./prolog-engine.js";
import { trace } from "./tracer.js";

var at = PrologEngine.atom, v = PrologEngine.variable;
var c = PrologEngine.compound, n = PrologEngine.num;

// ── Helper: count steps of a given action ────────────────────
function countAction(steps, action) {
  var count = 0;
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].action === action) count++;
  }
  return count;
}

// ── Helper: check if any step has given action ──────────────
function hasAction(steps, action) {
  return countAction(steps, action) > 0;
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("Trace simple fact query", function() {
  it("traces a single fact and finds solution", function() {
    var e = new PrologEngine();
    // parent(tom, bob).
    e.addClause(c("parent", [at("tom"), at("bob")]));

    var result = trace(e, c("parent", [at("tom"), at("bob")]));

    assert.ok(result.results.length > 0, "should have at least one result");
    assert.ok(result.steps.length > 0, "should have trace steps");
    assert.ok(hasAction(result.steps, "try"), "should have try step");
    assert.ok(hasAction(result.steps, "unify_ok"), "should have unify_ok step");
    assert.ok(hasAction(result.steps, "solution"), "should have solution step");
  });

  it("records the original goal in the trace", function() {
    var e = new PrologEngine();
    e.addClause(c("likes", [at("alice"), at("cats")]));

    var result = trace(e, c("likes", [at("alice"), at("cats")]));

    assert.equal(result.goal.type, "compound");
    assert.equal(result.goal.functor, "likes");
  });
});

describe("Trace with multiple clauses (some fail, some succeed)", function() {
  it("records both unify_ok and unify_fail", function() {
    var e = new PrologEngine();
    // color(red). color(blue). color(green).
    e.addClause(c("color", [at("red")]));
    e.addClause(c("color", [at("blue")]));
    e.addClause(c("color", [at("green")]));

    var result = trace(e, c("color", [at("blue")]));

    assert.equal(result.results.length, 1, "should find blue");
    assert.ok(hasAction(result.steps, "unify_fail"), "should have at least one unify_fail");
    assert.ok(hasAction(result.steps, "unify_ok"), "should have at least one unify_ok");

    // First clause (red) should fail, second (blue) should succeed
    var tries = [];
    for (var i = 0; i < result.steps.length; i++) {
      var s = result.steps[i];
      if (s.action === "try" || s.action === "unify_ok" || s.action === "unify_fail") {
        tries.push(s);
      }
    }
    // clause 0 (red): try then unify_fail
    assert.equal(tries[0].action, "try");
    assert.equal(tries[0].clauseIndex, 0);
    assert.equal(tries[1].action, "unify_fail");
    assert.equal(tries[1].clauseIndex, 0);

    // clause 1 (blue): try then unify_ok
    assert.equal(tries[2].action, "try");
    assert.equal(tries[2].clauseIndex, 1);
    assert.equal(tries[3].action, "unify_ok");
    assert.equal(tries[3].clauseIndex, 1);
  });

  it("finds all matching clauses with variable query", function() {
    var e = new PrologEngine();
    e.addClause(c("fruit", [at("apple")]));
    e.addClause(c("fruit", [at("banana")]));
    e.addClause(c("fruit", [at("cherry")]));

    var result = trace(e, c("fruit", [v("X")]));

    assert.equal(result.results.length, 3, "should find three fruits");
    assert.equal(countAction(result.steps, "solution"), 3, "should have three solution steps");
    assert.equal(countAction(result.steps, "unify_ok"), 3, "should have three unify_ok steps");
  });
});

describe("Trace a rule with body goals (depth increases)", function() {
  it("increases depth for body subgoals", function() {
    var e = new PrologEngine();
    // parent(tom, bob). parent(bob, ann).
    // grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
    e.addClause(c("parent", [at("tom"), at("bob")]));
    e.addClause(c("parent", [at("bob"), at("ann")]));
    e.addClause(
      c("grandparent", [v("X"), v("Z")]),
      [c("parent", [v("X"), v("Y")]), c("parent", [v("Y"), v("Z")])]
    );

    var result = trace(e, c("grandparent", [at("tom"), v("W")]));

    assert.equal(result.results.length, 1, "should find one grandchild");

    // Check that depth increases for body goals
    var maxDepth = 0;
    for (var i = 0; i < result.steps.length; i++) {
      if (result.steps[i].depth > maxDepth) {
        maxDepth = result.steps[i].depth;
      }
    }
    assert.ok(maxDepth >= 1, "depth should increase for body subgoals");

    // Verify solution term
    var sol = result.results[0];
    assert.equal(sol.functor, "grandparent");
    assert.equal(sol.args[1].name, "ann");
  });
});

describe("Trace with builtins (is/2, comparison)", function() {
  it("traces is/2 as builtin", function() {
    var e = new PrologEngine();
    // double(X, Y) :- Y is X * 2.
    e.addClause(
      c("double", [v("X"), v("Y")]),
      [c("is", [v("Y"), c("*", [v("X"), n(2)])])]
    );

    var result = trace(e, c("double", [n(5), v("R")]));

    assert.equal(result.results.length, 1, "should find one result");
    assert.ok(hasAction(result.steps, "builtin"), "should have a builtin step for is/2");

    // Find the builtin step
    var builtinSteps = [];
    for (var i = 0; i < result.steps.length; i++) {
      if (result.steps[i].action === "builtin") builtinSteps.push(result.steps[i]);
    }
    assert.ok(builtinSteps.length > 0, "should have at least one builtin step");
    assert.equal(builtinSteps[0].goal.functor, "is");
  });

  it("traces comparison builtin", function() {
    var e = new PrologEngine();
    // positive(X) :- X > 0.
    e.addClause(
      c("positive", [v("X")]),
      [c(">", [v("X"), n(0)])]
    );

    var result = trace(e, c("positive", [n(5)]));

    assert.equal(result.results.length, 1, "should find one result");
    assert.ok(hasAction(result.steps, "builtin"), "should have a builtin step for >/2");
  });
});

describe("Trace with not/1", function() {
  it("traces not/1 as builtin", function() {
    var e = new PrologEngine();
    // likes(alice, cats). likes(alice, dogs).
    // dislikes(X, Y) :- not(likes(X, Y)).
    e.addClause(c("likes", [at("alice"), at("cats")]));
    e.addClause(c("likes", [at("alice"), at("dogs")]));
    e.addClause(
      c("dislikes", [v("X"), v("Y")]),
      [c("not", [c("likes", [v("X"), v("Y")])])]
    );

    var result = trace(e, c("dislikes", [at("alice"), at("fish")]));

    assert.equal(result.results.length, 1, "should find that alice dislikes fish");
    assert.ok(hasAction(result.steps, "builtin"), "should have a builtin step for not/1");

    // Find the not builtin step
    var notSteps = [];
    for (var i = 0; i < result.steps.length; i++) {
      if (result.steps[i].action === "builtin" && result.steps[i].goal.functor === "not") {
        notSteps.push(result.steps[i]);
      }
    }
    assert.ok(notSteps.length > 0, "should have at least one not/1 builtin step");
  });

  it("not/1 fails when inner goal succeeds", function() {
    var e = new PrologEngine();
    e.addClause(c("likes", [at("alice"), at("cats")]));
    e.addClause(
      c("dislikes", [v("X"), v("Y")]),
      [c("not", [c("likes", [v("X"), v("Y")])])]
    );

    var result = trace(e, c("dislikes", [at("alice"), at("cats")]));

    assert.equal(result.results.length, 0, "should find no results (alice likes cats)");
    assert.ok(hasAction(result.steps, "builtin"), "should still trace the not/1 builtin");
    assert.ok(!hasAction(result.steps, "solution"), "should have no solution steps");
  });
});

describe("Trace a query with no solutions (all failures visible)", function() {
  it("shows only failures when nothing matches", function() {
    var e = new PrologEngine();
    e.addClause(c("color", [at("red")]));
    e.addClause(c("color", [at("blue")]));

    var result = trace(e, c("color", [at("green")]));

    assert.equal(result.results.length, 0, "should have no results");
    assert.ok(!hasAction(result.steps, "solution"), "should have no solution steps");
    assert.ok(hasAction(result.steps, "unify_fail"), "should have unify_fail steps");
    assert.equal(countAction(result.steps, "unify_fail"), 2, "should fail on both clauses");
  });

  it("shows failures for non-existent predicate", function() {
    var e = new PrologEngine();
    e.addClause(c("color", [at("red")]));

    var result = trace(e, c("shape", [at("circle")]));

    assert.equal(result.results.length, 0, "should have no results");
    // The clause for color won't match shape, so we see try+unify_fail
    assert.equal(countAction(result.steps, "unify_fail"), 1, "should fail on the one clause");
  });
});

describe("Verify maxSteps limits output", function() {
  it("stops tracing after maxSteps", function() {
    var e = new PrologEngine();
    // Create many clauses
    e.addClause(c("item", [at("a")]));
    e.addClause(c("item", [at("b")]));
    e.addClause(c("item", [at("c")]));
    e.addClause(c("item", [at("d")]));
    e.addClause(c("item", [at("e")]));
    e.addClause(c("item", [at("f")]));
    e.addClause(c("item", [at("g")]));
    e.addClause(c("item", [at("h")]));
    e.addClause(c("item", [at("i")]));
    e.addClause(c("item", [at("j")]));

    // With maxSteps=5, should stop early
    var result = trace(e, c("item", [v("X")]), { maxSteps: 5 });

    assert.ok(result.steps.length <= 5, "should have at most 5 steps, got " + result.steps.length);
    // Should not have all 10 solutions
    assert.ok(result.results.length < 10, "should not have all 10 results");
  });

  it("default maxSteps is 1000", function() {
    var e = new PrologEngine();
    e.addClause(c("fact", [at("a")]));
    var result = trace(e, c("fact", [at("a")]));
    // Just verify it works with defaults (no explosion)
    assert.ok(result.steps.length > 0, "should have some steps");
    assert.ok(result.steps.length <= 1000, "should respect default maxSteps");
  });

  it("maxResults limits solutions collected", function() {
    var e = new PrologEngine();
    for (var i = 0; i < 20; i++) {
      e.addClause(c("num", [n(i)]));
    }

    var result = trace(e, c("num", [v("X")]), { maxResults: 3 });

    assert.ok(result.results.length <= 3, "should have at most 3 results, got " + result.results.length);
  });
});

describe("Round-trip: trace.results matches engine.query", function() {
  it("results match for simple fact query", function() {
    var e = new PrologEngine();
    e.addClause(c("pet", [at("cat")]));
    e.addClause(c("pet", [at("dog")]));
    e.addClause(c("pet", [at("fish")]));

    var goal = c("pet", [v("X")]);
    var queryResults = e.query(goal);
    var traceResult = trace(e, goal);

    assert.equal(traceResult.results.length, queryResults.length, "same number of results");
    for (var i = 0; i < queryResults.length; i++) {
      assert.equal(termToString(traceResult.results[i]), termToString(queryResults[i]),
        "result " + i + " should match");
    }
  });

  it("results match for rule query", function() {
    var e = new PrologEngine();
    e.addClause(c("parent", [at("tom"), at("bob")]));
    e.addClause(c("parent", [at("bob"), at("ann")]));
    e.addClause(c("parent", [at("tom"), at("liz")]));
    e.addClause(
      c("grandparent", [v("X"), v("Z")]),
      [c("parent", [v("X"), v("Y")]), c("parent", [v("Y"), v("Z")])]
    );

    var goal = c("grandparent", [v("A"), v("B")]);
    var queryResults = e.query(goal);
    var traceResult = trace(e, goal);

    assert.equal(traceResult.results.length, queryResults.length, "same number of results");
    for (var i = 0; i < queryResults.length; i++) {
      assert.equal(termToString(traceResult.results[i]), termToString(queryResults[i]),
        "result " + i + " should match");
    }
  });

  it("results match with builtins", function() {
    var e = new PrologEngine();
    e.addClause(
      c("square", [v("X"), v("Y")]),
      [c("is", [v("Y"), c("*", [v("X"), v("X")])])]
    );

    var goal = c("square", [n(7), v("R")]);
    var queryResults = e.query(goal);
    var traceResult = trace(e, goal);

    assert.equal(traceResult.results.length, queryResults.length, "same number of results");
    for (var i = 0; i < queryResults.length; i++) {
      assert.equal(termToString(traceResult.results[i]), termToString(queryResults[i]),
        "result " + i + " should match");
    }
  });

  it("engine.solve is properly restored after trace", function() {
    var e = new PrologEngine();
    e.addClause(c("test", [at("ok")]));

    var origSolve = e.solve;
    trace(e, c("test", [at("ok")]));
    assert.ok(e.solve === origSolve, "solve should be restored to original");

    // Verify engine still works normally after trace
    var results = e.query(c("test", [at("ok")]));
    assert.equal(results.length, 1, "engine should still work");
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
