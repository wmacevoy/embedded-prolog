// ============================================================
// test-loader.js — Tests for the Prolog loader module
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
//
// Run with ANY JavaScript runtime:
//   node src/test-loader.js
//   deno run src/test-loader.js
//   bun run src/test-loader.js
// ============================================================

var _print = (typeof print !== "undefined" && typeof window === "undefined" && typeof Deno === "undefined") ? print : console.log.bind(console);

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
assert.throws   = function(fn, msg) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || "expected an error to be thrown");
};

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
        _print("    \u2713 " + test.name);
      } catch (e) {
        suite.fail++; totalFail++;
        _print("    \u2717 " + test.name);
        _print("      " + (e.message || e));
      }
    }
  }
  _print("\n  " + totalPass + " passing, " + totalFail + " failing\n");
  if (totalFail > 0 && typeof process !== "undefined" && process.exit) process.exit(1);
  return totalFail;
}

// ── Imports ─────────────────────────────────────────────────

import { loadString, loadFile } from "./loader.js";
import { PrologEngine, termToString } from "./prolog-engine.js";
import { createRequire } from "module";
var _cjsRequire = createRequire(import.meta.url);

// ── Family database used across tests ───────────────────────

var familyProgram =
  "% A simple family database\n" +
  "parent(tom, bob).\n" +
  "parent(tom, liz).\n" +
  "parent(bob, ann).\n" +
  "parent(bob, pat).\n" +
  "\n" +
  "grandparent(X, Z) :- parent(X, Y), parent(Y, Z).\n" +
  "sibling(X, Y) :- parent(P, X), parent(P, Y), X \\= Y.\n" +
  "ancestor(X, Y) :- parent(X, Y).\n" +
  "ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).\n";

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("loadString — simple fact", function() {
  it("loads a single fact and it is queryable", function() {
    var engine = new PrologEngine();
    loadString(engine, "likes(tom, beer).");

    var result = engine.queryFirst(
      PrologEngine.compound("likes", [PrologEngine.atom("tom"), PrologEngine.variable("X")])
    );
    assert.ok(result !== null, "should find likes(tom, X)");
    assert.equal(result.args[1].name, "beer");
  });
});

describe("loadString — multiple facts", function() {
  it("loads multiple facts and all are queryable", function() {
    var engine = new PrologEngine();
    loadString(engine, "color(red). color(green). color(blue).");

    var results = engine.query(
      PrologEngine.compound("color", [PrologEngine.variable("C")])
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].args[0].name, "red");
    assert.equal(results[1].args[0].name, "green");
    assert.equal(results[2].args[0].name, "blue");
  });
});

describe("loadString — rules", function() {
  it("loads rules and derived queries work", function() {
    var engine = new PrologEngine();
    loadString(engine,
      "parent(tom, bob).\n" +
      "parent(bob, ann).\n" +
      "grandparent(X, Z) :- parent(X, Y), parent(Y, Z).\n"
    );

    var result = engine.queryFirst(
      PrologEngine.compound("grandparent", [PrologEngine.atom("tom"), PrologEngine.variable("Z")])
    );
    assert.ok(result !== null, "should find grandparent(tom, Z)");
    assert.equal(result.args[1].name, "ann");
  });
});

describe("loadString — comments", function() {
  it("ignores line and block comments intermixed with clauses", function() {
    var engine = new PrologEngine();
    loadString(engine,
      "% this is a comment\n" +
      "fact(a).\n" +
      "/* block comment */\n" +
      "fact(b). % inline comment\n" +
      "% another comment\n" +
      "fact(c).\n"
    );

    var results = engine.query(
      PrologEngine.compound("fact", [PrologEngine.variable("X")])
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].args[0].name, "a");
    assert.equal(results[1].args[0].name, "b");
    assert.equal(results[2].args[0].name, "c");
  });
});

describe("loadString — return value", function() {
  it("returns the correct count of loaded clauses", function() {
    var engine = new PrologEngine();
    var count = loadString(engine,
      "a(1). a(2). a(3). b(x) :- a(x)."
    );
    assert.equal(count, 4);
  });

  it("returns 0 for empty string", function() {
    var engine = new PrologEngine();
    var count = loadString(engine, "");
    assert.equal(count, 0);
  });

  it("returns 0 for whitespace-only string", function() {
    var engine = new PrologEngine();
    var count = loadString(engine, "   \n  \n  ");
    assert.equal(count, 0);
  });

  it("returns 0 for comment-only string", function() {
    var engine = new PrologEngine();
    var count = loadString(engine, "% just a comment\n/* another */");
    assert.equal(count, 0);
  });
});

describe("Round-trip — family database", function() {
  it("loads the full family program", function() {
    var engine = new PrologEngine();
    var count = loadString(engine, familyProgram);
    assert.equal(count, 8);
  });

  it("queries parent facts", function() {
    var engine = new PrologEngine();
    loadString(engine, familyProgram);

    var results = engine.query(
      PrologEngine.compound("parent", [PrologEngine.atom("tom"), PrologEngine.variable("C")])
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].args[1].name, "bob");
    assert.equal(results[1].args[1].name, "liz");
  });

  it("queries grandparent rule", function() {
    var engine = new PrologEngine();
    loadString(engine, familyProgram);

    var results = engine.query(
      PrologEngine.compound("grandparent", [PrologEngine.atom("tom"), PrologEngine.variable("G")])
    );
    assert.equal(results.length, 2);
    // tom is grandparent of ann and pat (through bob)
    var names = [results[0].args[1].name, results[1].args[1].name];
    names.sort();
    assert.equal(names[0], "ann");
    assert.equal(names[1], "pat");
  });

  it("queries sibling rule", function() {
    var engine = new PrologEngine();
    loadString(engine, familyProgram);

    var results = engine.query(
      PrologEngine.compound("sibling", [PrologEngine.atom("ann"), PrologEngine.variable("S")])
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].args[1].name, "pat");
  });

  it("queries ancestor rule (recursive)", function() {
    var engine = new PrologEngine();
    loadString(engine, familyProgram);

    var results = engine.query(
      PrologEngine.compound("ancestor", [PrologEngine.atom("tom"), PrologEngine.variable("D")])
    );
    // tom -> bob, tom -> liz, tom -> ann (via bob), tom -> pat (via bob)
    assert.equal(results.length, 4);
    var names = [];
    for (var i = 0; i < results.length; i++) {
      names.push(results[i].args[1].name);
    }
    names.sort();
    assert.equal(names[0], "ann");
    assert.equal(names[1], "bob");
    assert.equal(names[2], "liz");
    assert.equal(names[3], "pat");
  });

  it("queries with no results return empty", function() {
    var engine = new PrologEngine();
    loadString(engine, familyProgram);

    var results = engine.query(
      PrologEngine.compound("parent", [PrologEngine.atom("ann"), PrologEngine.variable("X")])
    );
    assert.equal(results.length, 0);
  });
});

describe("Round-trip — vending-style program", function() {
  it("exercises rules with arithmetic and negation", function() {
    var engine = new PrologEngine();
    loadString(engine,
      "product(a1, cola, 125).\n" +
      "product(a2, water, 75).\n" +
      "product(a3, juice, 150).\n" +
      "cheap(Slot) :- product(Slot, _, Price), Price =< 100.\n" +
      "expensive(Slot) :- product(Slot, _, Price), Price > 100.\n" +
      "affordable(Slot, Budget) :- product(Slot, _, Price), Price =< Budget.\n"
    );

    // cheap should return only a2 (water at 75)
    var cheapResults = engine.query(
      PrologEngine.compound("cheap", [PrologEngine.variable("S")])
    );
    assert.equal(cheapResults.length, 1);
    assert.equal(cheapResults[0].args[0].name, "a2");

    // expensive should return a1 (125) and a3 (150)
    var expResults = engine.query(
      PrologEngine.compound("expensive", [PrologEngine.variable("S")])
    );
    assert.equal(expResults.length, 2);

    // affordable with budget 130 should return a1 (125) and a2 (75)
    var affResults = engine.query(
      PrologEngine.compound("affordable", [PrologEngine.variable("S"), PrologEngine.num(130)])
    );
    assert.equal(affResults.length, 2);
    var affNames = [affResults[0].args[0].name, affResults[1].args[0].name];
    affNames.sort();
    assert.equal(affNames[0], "a1");
    assert.equal(affNames[1], "a2");
  });
});

describe("loadFile", function() {
  it("loads a .pl file from disk, queries it, and cleans up", function() {
    var fs = _cjsRequire("fs");
    var os = _cjsRequire("os");
    var path = _cjsRequire("path");

    var tmpDir = os.tmpdir();
    var tmpFile = path.join(tmpDir, "test-loader-" + Date.now() + ".pl");

    fs.writeFileSync(tmpFile, familyProgram, "utf-8");

    try {
      var engine = new PrologEngine();
      var count = loadFile(engine, tmpFile);
      assert.equal(count, 8);

      // Verify queries work
      var result = engine.queryFirst(
        PrologEngine.compound("grandparent", [PrologEngine.atom("tom"), PrologEngine.variable("G")])
      );
      assert.ok(result !== null, "should find grandparent after loadFile");
      assert.equal(result.args[1].name, "ann");

      var siblings = engine.query(
        PrologEngine.compound("sibling", [PrologEngine.atom("bob"), PrologEngine.variable("S")])
      );
      assert.equal(siblings.length, 1);
      assert.equal(siblings[0].args[1].name, "liz");
    } finally {
      // Clean up
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
