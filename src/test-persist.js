// ============================================================
// test-persist.js — Tests for persist.js using in-memory mock
//
// Run:  node src/test-persist.js
// No npm dependencies needed — uses a mock adapter.
// ============================================================

import { PrologEngine } from './prolog-engine.js';
import { persist } from './persist.js';

var atom = PrologEngine.atom;
var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var num = PrologEngine.num;

var passed = 0, failed = 0;

// ── Mock adapter (in-memory, no better-sqlite3 needed) ──────

function MockAdapter() {
  this._rows = {};
}
MockAdapter.prototype.setup = function() {};
MockAdapter.prototype.insert = function(key) { this._rows[key] = true; };
MockAdapter.prototype.remove = function(key) { delete this._rows[key]; };
MockAdapter.prototype.all = function() {
  return Object.keys(this._rows);
};
MockAdapter.prototype.commit = function() {};
MockAdapter.prototype.close = function() {};

// ── Harness ─────────────────────────────────────────────────

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (e) {
    failed++;
    console.log("  \u2717 " + name + ": " + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Tests ───────────────────────────────────────────────────

console.log("persist.js");

test("facts survive restart", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.queryFirst(compound("assert", [compound("color", [atom("sky"), atom("blue")])]));
  e1.queryFirst(compound("assert", [compound("color", [atom("grass"), atom("green")])]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("color", [variable("X"), variable("Y")]));
  assert(results.length === 2, "expected 2, got " + results.length);
});

test("retract removes from DB", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.queryFirst(compound("assert", [compound("x", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("x", [num(2)])]));
  e1.queryFirst(compound("retract", [compound("x", [num(1)])]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("x", [variable("N")]));
  assert(results.length === 1, "expected 1, got " + results.length);
});

test("retractall clears from DB", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.queryFirst(compound("assert", [compound("t", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("t", [num(2)])]));
  e1.queryFirst(compound("assert", [compound("t", [num(3)])]));
  e1.queryFirst(compound("retractall", [compound("t", [variable("_")])]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("t", [variable("N")]));
  assert(results.length === 0, "expected 0, got " + results.length);
});

test("predicates filter", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db, { "keep/1": true });
  e1.queryFirst(compound("assert", [compound("keep", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("skip", [num(2)])]));

  var e2 = new PrologEngine();
  persist(e2, db, { "keep/1": true });
  var keep = e2.query(compound("keep", [variable("N")]));
  var skip = e2.query(compound("skip", [variable("N")]));
  assert(keep.length === 1, "expected 1 keep, got " + keep.length);
  assert(skip.length === 0, "expected 0 skip, got " + skip.length);
});

test("duplicate assert dedup", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.queryFirst(compound("assert", [compound("x", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("x", [num(1)])]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("x", [variable("N")]));
  assert(results.length === 1, "expected 1 (deduped), got " + results.length);
});

test("retract with pattern", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.queryFirst(compound("assert", [compound("kv", [atom("a"), num(1)])]));
  e1.queryFirst(compound("assert", [compound("kv", [atom("b"), num(2)])]));
  e1.queryFirst(compound("retract", [compound("kv", [atom("a"), variable("_")])]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("kv", [variable("K"), variable("V")]));
  assert(results.length === 1, "expected 1, got " + results.length);
  assert(results[0].args[0].name === "b", "expected key b");
});

test("retractall + assert update", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.queryFirst(compound("assert", [compound("temp", [atom("kitchen"), num(20)])]));
  e1.queryFirst(compound("retractall", [compound("temp", [atom("kitchen"), variable("_")])]));
  e1.queryFirst(compound("assert", [compound("temp", [atom("kitchen"), num(22)])]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("temp", [atom("kitchen"), variable("T")]));
  assert(results.length === 1, "expected 1, got " + results.length);
  assert(results[0].args[1].value === 22, "expected 22");
});

test("ephemeral = transaction", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();

  // Register ephemeral/1 (same as reactive-prolog.js)
  e1.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = e1.deepWalk(goal.args[0], subst);
    e1.clauses.push({ head: term, body: [] });
    try {
      e1.solve(rest, subst, counter, depth + 1, onSolution);
    } finally {
      e1.retractFirst(term);
    }
  };

  persist(e1, db);

  // Seed reading
  e1.queryFirst(compound("assert", [compound("reading", [atom("s1"), num(20)])]));

  // react: retractall old, assert new
  e1.addClause(atom("react"), [
    compound("signal", [variable("_From"), compound("reading", [variable("S"), variable("V")])]),
    compound("retractall", [compound("reading", [variable("S"), variable("_Old")])]),
    compound("assert", [compound("reading", [variable("S"), variable("V")])])
  ]);
  e1.addClause(compound("handle_signal", [variable("From"), variable("Fact")]), [
    compound("ephemeral", [compound("signal", [variable("From"), variable("Fact")])]),
    atom("react")
  ]);

  // Process signal
  e1.queryFirst(compound("handle_signal",
    [atom("s1"), compound("reading", [atom("s1"), num(25)])]));

  // New engine — should see updated reading
  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("reading", [atom("s1"), variable("V")]));
  assert(results.length === 1, "expected 1, got " + results.length);
  assert(results[0].args[1].value === 25, "expected 25, got " + results[0].args[1].value);
});

test("addClause persists facts", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.addClause(compound("sensor", [atom("s1"), atom("online")]));
  e1.addClause(compound("sensor", [atom("s2"), atom("offline")]));

  var e2 = new PrologEngine();
  persist(e2, db);
  var results = e2.query(compound("sensor", [variable("Id"), variable("Status")]));
  assert(results.length === 2, "expected 2, got " + results.length);
});

test("addClause skips rules", function() {
  var db = new MockAdapter();
  var e1 = new PrologEngine();
  persist(e1, db);
  e1.addClause(compound("x", [num(1)]));  // fact — persists
  e1.addClause(compound("double", [variable("X"), variable("Y")]),
    [compound("is", [variable("Y"), compound("*", [variable("X"), num(2)])])]
  );  // rule — skipped

  var e2 = new PrologEngine();
  persist(e2, db);
  var facts = e2.query(compound("x", [variable("N")]));
  assert(facts.length === 1, "expected 1 fact, got " + facts.length);
  assert(e2.clauses.length === 1, "expected 1 clause, got " + e2.clauses.length);
});

console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
