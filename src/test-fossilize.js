// ============================================================
// test-fossilize.js — Tests for fossilize()
//
// Run:  node src/test-fossilize.js
// ============================================================

import { PrologEngine } from './prolog-engine.js';
import { fossilize, mineralize } from './fossilize.js';

var atom = PrologEngine.atom;
var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var num = PrologEngine.num;

var passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log("  \u2713 " + name); }
  catch(e) { failed++; console.log("  \u2717 " + name + ": " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

console.log("fossilize.js");

test("queries still work", function() {
  var e = new PrologEngine();
  e.addClause(compound("color", [atom("sky"), atom("blue")]));
  e.addClause(compound("color", [atom("grass"), atom("green")]));
  fossilize(e);
  var results = e.query(compound("color", [variable("X"), variable("Y")]));
  assert(results.length === 2, "expected 2, got " + results.length);
});

test("rules still work", function() {
  var e = new PrologEngine();
  e.addClause(compound("parent", [atom("tom"), atom("bob")]));
  e.addClause(compound("parent", [atom("bob"), atom("ann")]));
  e.addClause(compound("grandparent", [variable("X"), variable("Z")]),
    [compound("parent", [variable("X"), variable("Y")]),
     compound("parent", [variable("Y"), variable("Z")])]);
  fossilize(e);
  var r = e.queryFirst(compound("grandparent", [atom("tom"), variable("Z")]));
  assert(r !== null, "grandparent should work");
  assert(r.args[1].name === "ann", "expected ann");
});

test("assert/1 blocked", function() {
  var e = new PrologEngine();
  fossilize(e);
  var r = e.queryFirst(compound("assert", [compound("x", [num(1)])]));
  assert(r === null, "assert should fail");
  assert(e.query(compound("x", [variable("N")])).length === 0, "no facts");
});

test("retract/1 blocked", function() {
  var e = new PrologEngine();
  e.addClause(compound("x", [num(1)]));
  fossilize(e);
  e.queryFirst(compound("retract", [compound("x", [num(1)])]));
  assert(e.query(compound("x", [variable("N")])).length === 1, "fact survives");
});

test("retractall/1 blocked", function() {
  var e = new PrologEngine();
  e.addClause(compound("x", [num(1)]));
  e.addClause(compound("x", [num(2)]));
  fossilize(e);
  e.queryFirst(compound("retractall", [compound("x", [variable("_")])]));
  assert(e.query(compound("x", [variable("N")])).length === 2, "both survive");
});

test("addClause blocked", function() {
  var e = new PrologEngine();
  fossilize(e);
  e.addClause(compound("x", [num(99)]));
  assert(e.query(compound("x", [variable("N")])).length === 0, "blocked");
});

test("ephemeral still works", function() {
  var e = new PrologEngine();
  e.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = e.deepWalk(goal.args[0], subst);
    e.clauses.push({ head: term, body: [] });
    try {
      e.solve(rest, subst, counter, depth + 1, onSolution);
    } finally {
      e.retractFirst(term);
    }
  };
  e.addClause(compound("handle", [variable("X")]),
    [compound("ephemeral", [compound("sig", [variable("X")])]),
     compound("sig", [variable("X")])]);
  fossilize(e);

  var r = e.queryFirst(compound("handle", [atom("hello")]));
  assert(r !== null, "ephemeral query should succeed");
  assert(e.queryFirst(compound("sig", [variable("X")])) === null, "ephemeral gone");
});

test("ephemeral doesn't leak", function() {
  var e = new PrologEngine();
  e.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = e.deepWalk(goal.args[0], subst);
    e.clauses.push({ head: term, body: [] });
    try {
      e.solve(rest, subst, counter, depth + 1, onSolution);
    } finally {
      e.retractFirst(term);
    }
  };
  e.addClause(atom("react"), [compound("sig", [variable("X")])]);
  e.addClause(compound("handle", [variable("X")]),
    [compound("ephemeral", [compound("sig", [variable("X")])]),
     atom("react")]);
  var boundary = fossilize(e);

  for (var i = 0; i < 100; i++) {
    e.queryFirst(compound("handle", [num(i)]));
  }
  assert(e.clauses.length === boundary,
    "expected " + boundary + " clauses, got " + e.clauses.length);
});

test("injection attempt fails", function() {
  var e = new PrologEngine();
  e.addClause(compound("trusted", [atom("sensor_1")]));
  e.addClause(compound("check", [variable("X")]),
    [compound("trusted", [variable("X")])]);
  fossilize(e);

  e.queryFirst(compound("assert", [compound("trusted", [atom("evil")])]));
  assert(e.queryFirst(compound("check", [atom("evil")])) === null, "injection blocked");
  assert(e.queryFirst(compound("check", [atom("sensor_1")])) !== null, "original intact");
});

// ── mineralize tests ────────────────────────────────────────

test("mineralize blocks assert on locked predicate", function() {
  var e = new PrologEngine();
  e.addClause(compound("threshold", [atom("btc"), num(70000)]));
  mineralize(e, "threshold", 2);
  e.queryFirst(compound("assert", [compound("threshold", [atom("eth"), num(4000)])]));
  var results = e.query(compound("threshold", [variable("S"), variable("L")]));
  assert(results.length === 1, "only original threshold, got " + results.length);
});

test("mineralize blocks retract on locked predicate", function() {
  var e = new PrologEngine();
  e.addClause(compound("threshold", [atom("btc"), num(70000)]));
  mineralize(e, "threshold", 2);
  e.queryFirst(compound("retract", [compound("threshold", [atom("btc"), num(70000)])]));
  var results = e.query(compound("threshold", [variable("S"), variable("L")]));
  assert(results.length === 1, "threshold should survive retract");
});

test("mineralize blocks retractall on locked predicate", function() {
  var e = new PrologEngine();
  e.addClause(compound("threshold", [atom("btc"), num(70000)]));
  e.addClause(compound("threshold", [atom("eth"), num(4000)]));
  mineralize(e, "threshold", 2);
  e.queryFirst(compound("retractall", [compound("threshold", [variable("_"), variable("__")])]));
  var results = e.query(compound("threshold", [variable("S"), variable("L")]));
  assert(results.length === 2, "both thresholds survive");
});

test("mineralize allows mutation on unlocked predicates", function() {
  var e = new PrologEngine();
  e.addClause(compound("threshold", [atom("btc"), num(70000)]));
  mineralize(e, "threshold", 2);
  // price/2 is NOT mineralized
  e.queryFirst(compound("assert", [compound("price", [atom("btc"), num(65000)])]));
  var prices = e.query(compound("price", [variable("S"), variable("P")]));
  assert(prices.length === 1, "price should be asserted");
  e.queryFirst(compound("retractall", [compound("price", [variable("_"), variable("__")])]));
  prices = e.query(compound("price", [variable("S"), variable("P")]));
  assert(prices.length === 0, "price should be retracted");
});

test("mineralize blocks addClause on locked predicate", function() {
  var e = new PrologEngine();
  mineralize(e, "react", 0);
  e.addClause(atom("react"), [atom("something")]);
  assert(e.clauses.length === 0, "addClause should be blocked");
});

test("mineralize multiple predicates independently", function() {
  var e = new PrologEngine();
  e.addClause(compound("rule_a", [num(1)]));
  e.addClause(compound("rule_b", [num(2)]));
  e.addClause(compound("data_c", [num(3)]));
  mineralize(e, "rule_a", 1);
  mineralize(e, "rule_b", 1);
  // rule_a and rule_b locked, data_c open
  e.queryFirst(compound("assert", [compound("rule_a", [num(99)])]));
  e.queryFirst(compound("assert", [compound("rule_b", [num(99)])]));
  e.queryFirst(compound("assert", [compound("data_c", [num(99)])]));
  assert(e.query(compound("rule_a", [variable("N")])).length === 1, "rule_a locked");
  assert(e.query(compound("rule_b", [variable("N")])).length === 1, "rule_b locked");
  assert(e.query(compound("data_c", [variable("N")])).length === 2, "data_c open");
});

test("mineralize is one-way (can't un-mineralize)", function() {
  var e = new PrologEngine();
  e.addClause(compound("x", [num(1)]));
  mineralize(e, "x", 1);
  // No API to un-mineralize
  assert(e.mineralized["x/1"] === true);
  e.queryFirst(compound("assert", [compound("x", [num(2)])]));
  assert(e.query(compound("x", [variable("N")])).length === 1, "still locked");
});

test("mineralize/1 callable from Prolog", function() {
  var e = new PrologEngine();
  mineralize(e, "_dummy", 0);  // initialize guards
  e.addClause(compound("secret", [num(42)]));
  e.queryFirst(compound("mineralize", [compound("/", [atom("secret"), num(1)])]));
  e.queryFirst(compound("assert", [compound("secret", [num(99)])]));
  var results = e.query(compound("secret", [variable("N")]));
  assert(results.length === 1, "secret locked via Prolog mineralize/1");
  assert(results[0].args[0].value === 42, "original value intact");
});

test("mineralize then fossilize", function() {
  var e = new PrologEngine();
  e.addClause(compound("rule", [num(1)]));
  e.addClause(compound("data", [num(2)]));
  mineralize(e, "rule", 1);
  // data still open
  e.queryFirst(compound("assert", [compound("data", [num(3)])]));
  assert(e.query(compound("data", [variable("N")])).length === 2, "data open before fossilize");
  // now fossilize — locks everything
  fossilize(e);
  e.queryFirst(compound("assert", [compound("data", [num(4)])]));
  assert(e.query(compound("data", [variable("N")])).length === 2, "data locked after fossilize");
});

console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
