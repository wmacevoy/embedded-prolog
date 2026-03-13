// ============================================================
// test-parser.js — Tests for the Prolog text parser
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
//
// Run with ANY JavaScript runtime:
//   node src/test-parser.js
//   deno run src/test-parser.js
//   bun run src/test-parser.js
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

import { parseTerm, parseClause, parseProgram } from "./parser.js";
import { PrologEngine, termToString } from "./prolog-engine.js";

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("Atoms", function() {
  it("parses a simple atom", function() {
    var t = parseTerm("foo");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "foo");
  });

  it("parses atom with underscores", function() {
    var t = parseTerm("can_vend");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "can_vend");
  });

  it("parses quoted atom", function() {
    var t = parseTerm("'OUT OF ORDER'");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "OUT OF ORDER");
  });

  it("parses quoted atom with escaped quote", function() {
    var t = parseTerm("'it''s'");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "it's");
  });

  it("parses empty list atom []", function() {
    var t = parseTerm("[]");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "[]");
  });

  it("parses cut atom !", function() {
    var t = parseTerm("!");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "!");
  });
});

describe("Numbers", function() {
  it("parses integer", function() {
    var t = parseTerm("42");
    assert.equal(t.type, "num");
    assert.equal(t.value, 42);
  });

  it("parses zero", function() {
    var t = parseTerm("0");
    assert.equal(t.type, "num");
    assert.equal(t.value, 0);
  });

  it("parses float", function() {
    var t = parseTerm("3.14");
    assert.equal(t.type, "num");
    assert.equal(t.value, 3.14);
  });

  it("parses negative integer via unary minus", function() {
    var t = parseTerm("-5");
    assert.equal(t.type, "num");
    assert.equal(t.value, -5);
  });

  it("parses negative float via unary minus", function() {
    var t = parseTerm("-3.14");
    assert.equal(t.type, "num");
    assert.equal(t.value, -3.14);
  });
});

describe("Variables", function() {
  it("parses uppercase variable", function() {
    var t = parseTerm("X");
    assert.equal(t.type, "var");
    assert.equal(t.name, "X");
  });

  it("parses multi-char variable", function() {
    var t = parseTerm("Slot");
    assert.equal(t.type, "var");
    assert.equal(t.name, "Slot");
  });

  it("parses anonymous variable", function() {
    var t = parseTerm("_");
    assert.equal(t.type, "var");
    assert.equal(t.name, "_");
  });

  it("parses named underscore variable", function() {
    var t = parseTerm("_Name");
    assert.equal(t.type, "var");
    assert.equal(t.name, "_Name");
  });
});

describe("Compound terms", function() {
  it("parses simple compound", function() {
    var t = parseTerm("f(a, b)");
    assert.equal(t.type, "compound");
    assert.equal(t.functor, "f");
    assert.equal(t.args.length, 2);
    assert.equal(t.args[0].type, "atom");
    assert.equal(t.args[0].name, "a");
    assert.equal(t.args[1].name, "b");
  });

  it("parses nested compound", function() {
    var t = parseTerm("f(g(x), h(y, z))");
    assert.equal(t.functor, "f");
    assert.equal(t.args[0].functor, "g");
    assert.equal(t.args[0].args[0].name, "x");
    assert.equal(t.args[1].functor, "h");
    assert.equal(t.args[1].args.length, 2);
  });

  it("parses zero-arity compound (bare atom)", function() {
    var t = parseTerm("hello");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "hello");
  });

  it("parses compound with number args", function() {
    var t = parseTerm("product(a1, cola, 125)");
    assert.equal(t.functor, "product");
    assert.equal(t.args[2].type, "num");
    assert.equal(t.args[2].value, 125);
  });

  it("parses compound with variable args", function() {
    var t = parseTerm("parent(X, Y)");
    assert.equal(t.functor, "parent");
    assert.equal(t.args[0].type, "var");
    assert.equal(t.args[0].name, "X");
  });
});

describe("Lists", function() {
  it("parses empty list", function() {
    var t = parseTerm("[]");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "[]");
  });

  it("parses single-element list", function() {
    var t = parseTerm("[a]");
    assert.equal(t.type, "compound");
    assert.equal(t.functor, ".");
    assert.equal(t.args[0].name, "a");
    assert.equal(t.args[1].type, "atom");
    assert.equal(t.args[1].name, "[]");
  });

  it("parses multi-element list", function() {
    var t = parseTerm("[a, b, c]");
    assert.equal(t.functor, ".");
    assert.equal(t.args[0].name, "a");
    var second = t.args[1];
    assert.equal(second.functor, ".");
    assert.equal(second.args[0].name, "b");
    var third = second.args[1];
    assert.equal(third.functor, ".");
    assert.equal(third.args[0].name, "c");
    assert.equal(third.args[1].name, "[]");
  });

  it("parses head|tail list", function() {
    var t = parseTerm("[H|T]");
    assert.equal(t.functor, ".");
    assert.equal(t.args[0].type, "var");
    assert.equal(t.args[0].name, "H");
    assert.equal(t.args[1].type, "var");
    assert.equal(t.args[1].name, "T");
  });

  it("parses list with multiple heads and tail", function() {
    var t = parseTerm("[a, b|T]");
    assert.equal(t.functor, ".");
    assert.equal(t.args[0].name, "a");
    var second = t.args[1];
    assert.equal(second.functor, ".");
    assert.equal(second.args[0].name, "b");
    assert.equal(second.args[1].type, "var");
    assert.equal(second.args[1].name, "T");
  });

  it("parses nested list", function() {
    var t = parseTerm("[[a, b], [c]]");
    assert.equal(t.functor, ".");
    // First element is [a, b]
    var first = t.args[0];
    assert.equal(first.functor, ".");
    assert.equal(first.args[0].name, "a");
  });

  it("matches PrologEngine.list structure", function() {
    var parsed = parseTerm("[a, b, c]");
    var built = PrologEngine.list([
      PrologEngine.atom("a"),
      PrologEngine.atom("b"),
      PrologEngine.atom("c")
    ]);
    assert.deepEqual(parsed, built);
  });
});

describe("Operators", function() {
  it("parses :- operator", function() {
    var t = parseTerm("head :- body");
    assert.equal(t.functor, ":-");
    assert.equal(t.args[0].name, "head");
    assert.equal(t.args[1].name, "body");
  });

  it("parses ; operator", function() {
    var t = parseTerm("a ; b");
    assert.equal(t.functor, ";");
    assert.equal(t.args[0].name, "a");
    assert.equal(t.args[1].name, "b");
  });

  it("parses -> operator", function() {
    var t = parseTerm("a -> b");
    assert.equal(t.functor, "->");
    assert.equal(t.args[0].name, "a");
    assert.equal(t.args[1].name, "b");
  });

  it("parses , operator", function() {
    var t = parseTerm("a , b");
    assert.equal(t.functor, ",");
    assert.equal(t.args[0].name, "a");
    assert.equal(t.args[1].name, "b");
  });

  it("parses = operator", function() {
    var t = parseTerm("X = 5");
    assert.equal(t.functor, "=");
    assert.equal(t.args[0].name, "X");
    assert.equal(t.args[1].value, 5);
  });

  it("parses \\= operator", function() {
    var t = parseTerm("X \\= Y");
    assert.equal(t.functor, "\\=");
  });

  it("parses == operator", function() {
    var t = parseTerm("X == Y");
    assert.equal(t.functor, "==");
  });

  it("parses \\== operator", function() {
    var t = parseTerm("X \\== Y");
    assert.equal(t.functor, "\\==");
  });

  it("parses is operator", function() {
    var t = parseTerm("X is 3 + 4");
    assert.equal(t.functor, "is");
    assert.equal(t.args[0].name, "X");
    assert.equal(t.args[1].functor, "+");
  });

  it("parses =:= operator", function() {
    var t = parseTerm("X =:= Y");
    assert.equal(t.functor, "=:=");
  });

  it("parses =\\= operator", function() {
    var t = parseTerm("X =\\= Y");
    assert.equal(t.functor, "=\\=");
  });

  it("parses < operator", function() {
    var t = parseTerm("X < 10");
    assert.equal(t.functor, "<");
  });

  it("parses > operator", function() {
    var t = parseTerm("X > 0");
    assert.equal(t.functor, ">");
    assert.equal(t.args[1].value, 0);
  });

  it("parses >= operator", function() {
    var t = parseTerm("X >= Y");
    assert.equal(t.functor, ">=");
  });

  it("parses =< operator", function() {
    var t = parseTerm("X =< Y");
    assert.equal(t.functor, "=<");
  });

  it("parses + operator", function() {
    var t = parseTerm("1 + 2");
    assert.equal(t.functor, "+");
    assert.equal(t.args[0].value, 1);
    assert.equal(t.args[1].value, 2);
  });

  it("parses - operator (binary)", function() {
    var t = parseTerm("5 - 3");
    assert.equal(t.functor, "-");
    assert.equal(t.args[0].value, 5);
    assert.equal(t.args[1].value, 3);
  });

  it("parses * operator", function() {
    var t = parseTerm("3 * 4");
    assert.equal(t.functor, "*");
  });

  it("parses // operator", function() {
    var t = parseTerm("10 // 3");
    assert.equal(t.functor, "//");
  });

  it("parses mod operator", function() {
    var t = parseTerm("10 mod 3");
    assert.equal(t.functor, "mod");
  });

  it("parses \\+ prefix operator", function() {
    var t = parseTerm("\\+ foo");
    assert.equal(t.functor, "\\+");
    assert.equal(t.args.length, 1);
    assert.equal(t.args[0].name, "foo");
  });

  it("parses not prefix operator", function() {
    var t = parseTerm("not foo");
    assert.equal(t.functor, "not");
    assert.equal(t.args.length, 1);
    assert.equal(t.args[0].name, "foo");
  });

  it("parses abs prefix operator", function() {
    var t = parseTerm("abs(X)");
    assert.equal(t.functor, "abs");
    assert.equal(t.args.length, 1);
    assert.equal(t.args[0].name, "X");
  });
});

describe("Operator precedence", function() {
  it("* binds tighter than +", function() {
    var t = parseTerm("1 + 2 * 3");
    assert.equal(t.functor, "+");
    assert.equal(t.args[0].value, 1);
    assert.equal(t.args[1].functor, "*");
    assert.equal(t.args[1].args[0].value, 2);
    assert.equal(t.args[1].args[1].value, 3);
  });

  it(", binds tighter than :-", function() {
    var t = parseTerm("h :- a, b");
    assert.equal(t.functor, ":-");
    assert.equal(t.args[1].functor, ",");
  });

  it("; binds looser than ,", function() {
    var t = parseTerm("a, b ; c, d");
    assert.equal(t.functor, ";");
    assert.equal(t.args[0].functor, ",");
    assert.equal(t.args[1].functor, ",");
  });

  it("-> binds between ; and ,", function() {
    var t = parseTerm("a -> b ; c");
    assert.equal(t.functor, ";");
    assert.equal(t.args[0].functor, "->");
  });

  it("is binds looser than arithmetic", function() {
    var t = parseTerm("X is A + B * C");
    assert.equal(t.functor, "is");
    assert.equal(t.args[1].functor, "+");
    assert.equal(t.args[1].args[1].functor, "*");
  });

  it("comparison binds looser than arithmetic", function() {
    var t = parseTerm("X + 1 > Y - 2");
    assert.equal(t.functor, ">");
    assert.equal(t.args[0].functor, "+");
    assert.equal(t.args[1].functor, "-");
  });
});

describe("Parenthesized expressions", function() {
  it("parens override precedence", function() {
    var t = parseTerm("(1 + 2) * 3");
    assert.equal(t.functor, "*");
    assert.equal(t.args[0].functor, "+");
  });

  it("parens in clause body", function() {
    var t = parseTerm("a, (b ; c), d");
    assert.equal(t.functor, ",");
    // a , ((b ; c), d)
    assert.equal(t.args[0].name, "a");
    var rest = t.args[1]; // (b ; c) , d
    assert.equal(rest.functor, ",");
    assert.equal(rest.args[0].functor, ";");
    assert.equal(rest.args[1].name, "d");
  });
});

describe("Comments", function() {
  it("skips line comments", function() {
    var t = parseTerm("% this is a comment\nfoo");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "foo");
  });

  it("skips block comments", function() {
    var t = parseTerm("/* block */ foo");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "foo");
  });

  it("handles comment between terms", function() {
    var t = parseTerm("f(/* arg1 */ a, /* arg2 */ b)");
    assert.equal(t.functor, "f");
    assert.equal(t.args[0].name, "a");
    assert.equal(t.args[1].name, "b");
  });
});

describe("parseClause - facts", function() {
  it("parses a simple fact", function() {
    var c = parseClause("parent(tom, bob).");
    assert.equal(c.head.type, "compound");
    assert.equal(c.head.functor, "parent");
    assert.equal(c.head.args[0].name, "tom");
    assert.equal(c.head.args[1].name, "bob");
    assert.equal(c.body.length, 0);
  });

  it("parses a fact with numbers", function() {
    var c = parseClause("product(a1, cola, 125).");
    assert.equal(c.head.functor, "product");
    assert.equal(c.head.args[2].value, 125);
    assert.equal(c.body.length, 0);
  });

  it("parses a zero-arity fact", function() {
    var c = parseClause("true.");
    assert.equal(c.head.type, "atom");
    assert.equal(c.head.name, "true");
    assert.equal(c.body.length, 0);
  });
});

describe("parseClause - rules", function() {
  it("parses a simple rule", function() {
    var c = parseClause("valid(X) :- check(X), X > 0.");
    assert.equal(c.head.functor, "valid");
    assert.equal(c.head.args[0].name, "X");
    assert.equal(c.body.length, 2);
    assert.equal(c.body[0].functor, "check");
    assert.equal(c.body[1].functor, ">");
    assert.equal(c.body[1].args[0].name, "X");
    assert.equal(c.body[1].args[1].value, 0);
  });

  it("flattens top-level commas in body", function() {
    var c = parseClause("test :- a, b, c.");
    assert.equal(c.body.length, 3);
    assert.equal(c.body[0].name, "a");
    assert.equal(c.body[1].name, "b");
    assert.equal(c.body[2].name, "c");
  });

  it("does not flatten commas inside ;", function() {
    var c = parseClause("test :- a, (b ; c), d.");
    assert.equal(c.body.length, 3);
    assert.equal(c.body[0].name, "a");
    assert.equal(c.body[1].functor, ";");
    assert.equal(c.body[2].name, "d");
  });

  it("does not flatten commas inside ->", function() {
    var c = parseClause("test :- (a -> b, c ; d).");
    assert.equal(c.body.length, 1);
    assert.equal(c.body[0].functor, ";");
  });

  it("parses rule with not/\\+", function() {
    var c = parseClause("safe(X) :- \\+ danger(X).");
    assert.equal(c.body.length, 1);
    assert.equal(c.body[0].functor, "\\+");
    assert.equal(c.body[0].args[0].functor, "danger");
  });

  it("parses rule with is and arithmetic", function() {
    var c = parseClause("double(X, Y) :- Y is X * 2.");
    assert.equal(c.body.length, 1);
    assert.equal(c.body[0].functor, "is");
    assert.equal(c.body[0].args[1].functor, "*");
  });

  it("parses can_vend rule from vending KB", function() {
    var c = parseClause(
      "can_vend(Slot) :- " +
      "machine_state(idle), " +
      "\\+ has_any_fault, " +
      "product(Slot, _, Price), " +
      "credit(Credit), Credit >= Price, " +
      "inventory(Slot, Count), Count > 0."
    );
    assert.equal(c.head.functor, "can_vend");
    assert.equal(c.body.length, 7);
    assert.equal(c.body[0].functor, "machine_state");
    assert.equal(c.body[1].functor, "\\+");
    assert.equal(c.body[2].functor, "product");
    assert.equal(c.body[3].functor, "credit");
    assert.equal(c.body[4].functor, ">=");
    assert.equal(c.body[5].functor, "inventory");
    assert.equal(c.body[6].functor, ">");
  });
});

describe("parseProgram", function() {
  it("parses multiple facts", function() {
    var prog = parseProgram("parent(tom, bob). parent(tom, liz). parent(bob, ann).");
    assert.equal(prog.length, 3);
    assert.equal(prog[0].head.functor, "parent");
    assert.equal(prog[0].head.args[0].name, "tom");
    assert.equal(prog[1].head.args[1].name, "liz");
    assert.equal(prog[2].head.args[0].name, "bob");
  });

  it("parses mix of facts and rules", function() {
    var prog = parseProgram(
      "parent(tom, bob).\n" +
      "parent(bob, ann).\n" +
      "grandparent(X, Z) :- parent(X, Y), parent(Y, Z).\n"
    );
    assert.equal(prog.length, 3);
    assert.equal(prog[2].head.functor, "grandparent");
    assert.equal(prog[2].body.length, 2);
  });

  it("handles comments in program", function() {
    var prog = parseProgram(
      "% Facts\n" +
      "fact(a). % first fact\n" +
      "/* more facts */\n" +
      "fact(b).\n"
    );
    assert.equal(prog.length, 2);
  });

  it("parses the vending machine Prolog source", function() {
    var src =
      "product(a1, cola, 125).\n" +
      "product(a2, water, 75).\n" +
      "fault_condition(tilt_detected) :- sensor(tilt, tilted).\n" +
      "has_critical_fault :- fault_condition(tilt_detected).\n" +
      "display_message('OUT OF ORDER') :- fault_condition(tilt_detected).\n";
    var prog = parseProgram(src);
    assert.equal(prog.length, 5);
    assert.equal(prog[0].head.functor, "product");
    assert.equal(prog[0].body.length, 0);
    assert.equal(prog[2].head.functor, "fault_condition");
    assert.equal(prog[2].body.length, 1);
    assert.equal(prog[3].head.name, "has_critical_fault");
    assert.equal(prog[4].head.functor, "display_message");
    assert.equal(prog[4].head.args[0].name, "OUT OF ORDER");
  });
});

describe("Round-trip: parse then query", function() {
  it("parse fact, add to engine, query it", function() {
    var engine = new PrologEngine();
    var clause = parseClause("parent(tom, bob).");
    engine.addClause(clause.head, clause.body);

    var result = engine.queryFirst(
      PrologEngine.compound("parent", [PrologEngine.atom("tom"), PrologEngine.variable("X")])
    );
    assert.ok(result !== null, "should find parent(tom, X)");
    assert.equal(result.args[1].name, "bob");
  });

  it("parse rule, add to engine, query it", function() {
    var engine = new PrologEngine();

    var prog = parseProgram(
      "parent(tom, bob).\n" +
      "parent(bob, ann).\n" +
      "grandparent(X, Z) :- parent(X, Y), parent(Y, Z).\n"
    );

    for (var i = 0; i < prog.length; i++) {
      engine.addClause(prog[i].head, prog[i].body);
    }

    var result = engine.queryFirst(
      PrologEngine.compound("grandparent", [PrologEngine.atom("tom"), PrologEngine.variable("Z")])
    );
    assert.ok(result !== null, "should find grandparent(tom, Z)");
    assert.equal(result.args[1].name, "ann");
  });

  it("parse arithmetic rule, compute result", function() {
    var engine = new PrologEngine();
    var prog = parseProgram(
      "double(X, Y) :- Y is X * 2.\n"
    );
    for (var i = 0; i < prog.length; i++) {
      engine.addClause(prog[i].head, prog[i].body);
    }
    var result = engine.queryFirst(
      PrologEngine.compound("double", [PrologEngine.num(5), PrologEngine.variable("Y")])
    );
    assert.ok(result !== null);
    assert.equal(result.args[1].value, 10);
  });

  it("parse comparison rule, test it", function() {
    var engine = new PrologEngine();
    var prog = parseProgram(
      "positive(X) :- X > 0.\n"
    );
    for (var i = 0; i < prog.length; i++) {
      engine.addClause(prog[i].head, prog[i].body);
    }
    var result = engine.queryFirst(
      PrologEngine.compound("positive", [PrologEngine.num(5)])
    );
    assert.ok(result !== null, "5 should be positive");

    var result2 = engine.queryFirst(
      PrologEngine.compound("positive", [PrologEngine.num(-3)])
    );
    assert.ok(result2 === null, "-3 should not be positive");
  });

  it("parse not/negation rule, test it", function() {
    var engine = new PrologEngine();
    var prog = parseProgram(
      "likes(tom, beer).\n" +
      "likes(tom, wine).\n" +
      "dislikes(tom, X) :- \\+ likes(tom, X).\n"
    );
    for (var i = 0; i < prog.length; i++) {
      engine.addClause(prog[i].head, prog[i].body);
    }
    // tom dislikes water (not in likes)
    var result = engine.queryFirst(
      PrologEngine.compound("dislikes", [PrologEngine.atom("tom"), PrologEngine.atom("water")])
    );
    assert.ok(result !== null, "tom should dislike water");

    // tom does not dislike beer
    var result2 = engine.queryFirst(
      PrologEngine.compound("dislikes", [PrologEngine.atom("tom"), PrologEngine.atom("beer")])
    );
    assert.ok(result2 === null, "tom should not dislike beer");
  });

  it("parse list-based rule, test member", function() {
    var engine = new PrologEngine();
    var prog = parseProgram(
      "colors([red, green, blue]).\n"
    );
    for (var i = 0; i < prog.length; i++) {
      engine.addClause(prog[i].head, prog[i].body);
    }
    var result = engine.queryFirst(
      PrologEngine.compound("colors", [PrologEngine.variable("L")])
    );
    assert.ok(result !== null);
    // The list should be .(red, .(green, .(blue, [])))
    assert.equal(result.args[0].functor, ".");
    assert.equal(result.args[0].args[0].name, "red");
  });

  it("parse multi-clause vending-style program", function() {
    var engine = new PrologEngine();
    var prog = parseProgram(
      "product(a1, cola, 125).\n" +
      "product(a2, water, 75).\n" +
      "cheap(Slot) :- product(Slot, _, Price), Price =< 100.\n"
    );
    for (var i = 0; i < prog.length; i++) {
      engine.addClause(prog[i].head, prog[i].body);
    }
    var results = engine.query(
      PrologEngine.compound("cheap", [PrologEngine.variable("S")])
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].args[0].name, "a2");
  });
});

describe("Error handling", function() {
  it("throws on unexpected token", function() {
    assert.throws(function() {
      parseTerm(")");
    });
  });

  it("throws on unmatched paren", function() {
    assert.throws(function() {
      parseTerm("f(a, b");
    });
  });

  it("throws on unmatched bracket", function() {
    assert.throws(function() {
      parseTerm("[a, b");
    });
  });

  it("throws on missing argument", function() {
    assert.throws(function() {
      parseTerm("f(, b)");
    });
  });
});

describe("Edge cases", function() {
  it("parses deeply nested expression", function() {
    var t = parseTerm("f(g(h(x)))");
    assert.equal(t.functor, "f");
    assert.equal(t.args[0].functor, "g");
    assert.equal(t.args[0].args[0].functor, "h");
    assert.equal(t.args[0].args[0].args[0].name, "x");
  });

  it("parses complex arithmetic", function() {
    var t = parseTerm("1 + 2 * 3 - 4 // 2");
    // Should be: (1 + (2*3)) - (4//2)
    assert.equal(t.functor, "-");
    assert.equal(t.args[0].functor, "+");
    assert.equal(t.args[0].args[1].functor, "*");
    assert.equal(t.args[1].functor, "//");
  });

  it("handles whitespace around operators", function() {
    var t = parseTerm("  X   =   Y  ");
    assert.equal(t.functor, "=");
  });

  it("parses assert/retract terms", function() {
    var t = parseTerm("assert(credit(100))");
    assert.equal(t.functor, "assert");
    assert.equal(t.args[0].functor, "credit");
    assert.equal(t.args[0].args[0].value, 100);
  });

  it("parses not(compound) as compound not atom", function() {
    var t = parseTerm("not(has_fault)");
    assert.equal(t.type, "compound");
    assert.equal(t.functor, "not");
    assert.equal(t.args.length, 1);
    assert.equal(t.args[0].name, "has_fault");
  });

  it("parses findall/3", function() {
    var t = parseTerm("findall(X, member(X, L), Result)");
    assert.equal(t.functor, "findall");
    assert.equal(t.args.length, 3);
  });

  it("parses clause with quoted atom in head", function() {
    var c = parseClause("display_message('INSERT COINS') :- machine_state(idle).");
    assert.equal(c.head.functor, "display_message");
    assert.equal(c.head.args[0].name, "INSERT COINS");
    assert.equal(c.body.length, 1);
  });

  it("term structure matches PrologEngine constructors", function() {
    var parsed = parseTerm("f(a, 42, X)");
    var built = PrologEngine.compound("f", [
      PrologEngine.atom("a"),
      PrologEngine.num(42),
      PrologEngine.variable("X")
    ]);
    assert.deepEqual(parsed, built);
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
