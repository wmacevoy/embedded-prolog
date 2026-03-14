// ============================================================
// test-store.js — Tests for store.js key/value shim
//
// Run:  node src/test-store.js
// ============================================================

import { createStore, _toTerm, _fromTerm } from './store.js';
import { PrologEngine } from './prolog-engine.js';

var passed = 0, failed = 0;

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

// ── Value conversion ────────────────────────────────────────

console.log("store.js");

test("toTerm number", function() {
  var t = _toTerm(42);
  assert(t.type === "num" && t.value === 42);
});

test("toTerm string", function() {
  var t = _toTerm("hello");
  assert(t.type === "atom" && t.name === "hello");
});

test("toTerm boolean true", function() {
  var t = _toTerm(true);
  assert(t.type === "atom" && t.name === "true");
});

test("toTerm boolean false", function() {
  var t = _toTerm(false);
  assert(t.type === "atom" && t.name === "false");
});

test("toTerm null", function() {
  var t = _toTerm(null);
  assert(t.type === "atom" && t.name === "null");
});

test("toTerm object → JSON atom", function() {
  var t = _toTerm({ x: 1 });
  assert(t.type === "atom");
  assert(JSON.parse(t.name).x === 1);
});

test("fromTerm number", function() {
  assert(_fromTerm({ type: "num", value: 42 }) === 42);
});

test("fromTerm string atom", function() {
  assert(_fromTerm({ type: "atom", name: "hello" }) === "hello");
});

test("fromTerm true", function() {
  assert(_fromTerm({ type: "atom", name: "true" }) === true);
});

test("fromTerm false", function() {
  assert(_fromTerm({ type: "atom", name: "false" }) === false);
});

test("fromTerm null", function() {
  assert(_fromTerm({ type: "atom", name: "null" }) === null);
});

test("fromTerm JSON object", function() {
  var v = _fromTerm({ type: "atom", name: '{"x":1}' });
  assert(typeof v === "object" && v.x === 1);
});

test("round-trip number", function() {
  assert(_fromTerm(_toTerm(3.14)) === 3.14);
});

test("round-trip string", function() {
  assert(_fromTerm(_toTerm("hello")) === "hello");
});

test("round-trip boolean", function() {
  assert(_fromTerm(_toTerm(true)) === true);
  assert(_fromTerm(_toTerm(false)) === false);
});

test("round-trip null", function() {
  assert(_fromTerm(_toTerm(null)) === null);
});

// ── Store API ───────────────────────────────────────────────

test("set and get", function() {
  var s = createStore();
  s.set("name", "Alice");
  assert(s.get("name") === "Alice");
});

test("set overwrites", function() {
  var s = createStore();
  s.set("x", 1);
  s.set("x", 2);
  assert(s.get("x") === 2);
});

test("get missing key → undefined", function() {
  var s = createStore();
  assert(s.get("nope") === undefined);
});

test("delete removes key", function() {
  var s = createStore();
  s.set("x", 42);
  s.delete("x");
  assert(s.get("x") === undefined);
});

test("has", function() {
  var s = createStore();
  assert(s.has("x") === false);
  s.set("x", 1);
  assert(s.has("x") === true);
  s.delete("x");
  assert(s.has("x") === false);
});

test("keys", function() {
  var s = createStore();
  s.set("a", 1);
  s.set("b", 2);
  s.set("c", 3);
  var k = s.keys();
  assert(k.length === 3);
  assert(k.indexOf("a") >= 0);
  assert(k.indexOf("b") >= 0);
  assert(k.indexOf("c") >= 0);
});

test("entries", function() {
  var s = createStore();
  s.set("x", 10);
  s.set("y", 20);
  var e = s.entries();
  assert(e.length === 2);
  var found = {};
  for (var i = 0; i < e.length; i++) found[e[i][0]] = e[i][1];
  assert(found.x === 10 && found.y === 20);
});

test("stores numbers", function() {
  var s = createStore();
  s.set("pi", 3.14159);
  assert(s.get("pi") === 3.14159);
});

test("stores booleans", function() {
  var s = createStore();
  s.set("flag", true);
  assert(s.get("flag") === true);
  s.set("flag", false);
  assert(s.get("flag") === false);
});

test("stores null", function() {
  var s = createStore();
  s.set("gone", null);
  assert(s.get("gone") === null);
  assert(s.has("gone") === true);  // null is a value, not absent
});

test("stores objects via JSON", function() {
  var s = createStore();
  s.set("config", { threshold: 70000, active: true });
  var v = s.get("config");
  assert(typeof v === "object");
  assert(v.threshold === 70000);
  assert(v.active === true);
});

test("stores arrays via JSON", function() {
  var s = createStore();
  s.set("items", [1, 2, 3]);
  var v = s.get("items");
  assert(Array.isArray(v));
  assert(v.length === 3 && v[0] === 1);
});

// ── Reactive ────────────────────────────────────────────────

test("on fires when value changes", function() {
  var s = createStore();
  s.set("count", 0);
  var seen = [];
  s.on("count", function(val) { seen.push(val); });
  s.set("count", 1);
  s.set("count", 2);
  assert(seen.length >= 2, "expected at least 2 callbacks, got " + seen.length);
  assert(seen[seen.length - 1] === 2, "last value should be 2");
});

test("on does not fire for other keys", function() {
  var s = createStore();
  s.set("a", 1);
  var seen = [];
  s.on("a", function(val) { seen.push(val); });
  s.set("b", 2);  // different key
  s.set("b", 3);
  assert(seen.length === 0, "should not fire for key 'b'");
});

test("off unsubscribes", function() {
  var s = createStore();
  s.set("x", 0);
  var seen = [];
  var off = s.on("x", function(val) { seen.push(val); });
  s.set("x", 1);
  off();
  s.set("x", 2);
  assert(seen.length === 1, "should have 1 callback before off");
  assert(seen[0] === 1);
});

test("multiple watchers on same key", function() {
  var s = createStore();
  s.set("x", 0);
  var a = [], b = [];
  s.on("x", function(val) { a.push(val); });
  s.on("x", function(val) { b.push(val); });
  s.set("x", 5);
  assert(a.length >= 1 && a[0] === 5);
  assert(b.length >= 1 && b[0] === 5);
});

// ── Escape hatch ────────────────────────────────────────────

test("engine escape hatch", function() {
  var s = createStore();
  s.set("x", 42);
  // Direct Prolog query
  var results = s.engine.query(
    PrologEngine.compound("kv", [PrologEngine.variable("K"), PrologEngine.variable("V")])
  );
  assert(results.length === 1);
  assert(results[0].args[0].name === "x");
  assert(results[0].args[1].value === 42);
});

console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
