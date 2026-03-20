// ============================================================
// test.js — Vending machine tests
//
// All inputs via ephemeral events.  No direct state mutation.
//
// Run with ANY JavaScript runtime:
//   node examples/vending/test.js
//   bun run examples/vending/test.js
//   deno run examples/vending/test.js
//   qjs --module examples/vending/test.js
// ============================================================

// ── print() polyfill ────────────────────────────────────────
var _print = (typeof print !== "undefined") ? print : console.log.bind(console);

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

import { PrologEngine, termToString, listToArray } from "../../src/prolog-engine.js";
import { createSignal, createMemo, createEffect } from "../../src/reactive.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { buildVendingKB } from "./vending-kb.js";

var at = PrologEngine.atom, v = PrologEngine.variable;
var c = PrologEngine.compound, n = PrologEngine.num;
var obj = PrologEngine.object;

// ── Event helpers (all inputs via ephemeral) ────────────────

function sensorEvent(name, value) {
  return c("ephemeral", [obj([
    {key: "type", value: at("sensor")},
    {key: "name", value: at(name)},
    {key: "value", value: at(value)}
  ])]);
}

function coinEvent(amount) {
  return c("ephemeral", [obj([
    {key: "type", value: at("coin")},
    {key: "amount", value: n(amount)}
  ])]);
}

function selectEvent(slot) {
  return c("ephemeral", [obj([
    {key: "type", value: at("select")},
    {key: "slot", value: at(slot)}
  ])]);
}

function vendCompleteEvent() {
  return c("ephemeral", [obj([{key: "type", value: at("vend_complete")}])]);
}

function returnCreditEvent() {
  return c("ephemeral", [obj([{key: "type", value: at("return_credit")}])]);
}

// ── Query helpers ───────────────────────────────────────────

function getCredit(e)  { var r = e.queryFirst(c("credit",[v("C")])); return r ? r.args[0].value : 0; }
function getState(e)   { var r = e.queryFirst(c("machine_state",[v("S")])); return r ? r.args[0].name : "?"; }
function getDisplay(e) { var r = e.queryFirst(c("display_message",[v("M")])); return r ? r.args[0].name : "?"; }
function getFaults(e)  { var r = e.queryFirst(c("all_faults",[v("F")])); return r ? listToArray(r.args[0]).map(function(t){return t.name;}) : []; }
function getAvailable(e) { var r = e.queryFirst(c("available_slots",[v("S")])); return r ? listToArray(r.args[0]).map(function(t){return t.name;}) : []; }

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("Happy path", function() {
  it("starts idle, zero credit, INSERT COINS", function() {
    var e = buildVendingKB();
    assert.equal(getState(e), "idle");
    assert.equal(getCredit(e), 0);
    assert.equal(getDisplay(e), "INSERT COINS");
  });
  it("accepts coins via ephemeral", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(25));
    assert.equal(getCredit(e), 25);
    e.queryFirst(coinEvent(100));
    assert.equal(getCredit(e), 125);
  });
  it("vends and gives change", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(100));
    e.queryFirst(coinEvent(100));
    e.queryFirst(selectEvent("a1")); // cola 125¢
    assert.equal(getCredit(e), 75); // 200-125
    assert.equal(getState(e), "vending");
  });
  it("decrements inventory", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(125));
    e.queryFirst(selectEvent("a1"));
    assert.equal(e.queryFirst(c("inventory",[at("a1"),v("C")])).args[1].value, 7);
  });
  it("returns to idle after vend_complete", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(125));
    e.queryFirst(selectEvent("a1"));
    e.queryFirst(vendCompleteEvent());
    assert.equal(getState(e), "idle");
  });
  it("returns credit via ephemeral", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(100));
    e.queryFirst(returnCreditEvent());
    assert.equal(getCredit(e), 0);
  });
});

describe("Fault detection", function() {
  it("tilt sensor → tilt fault → display", function() {
    var e = buildVendingKB();
    assert.deepEqual(getFaults(e), []);
    e.queryFirst(sensorEvent("tilt", "tilted"));
    assert.deepEqual(getFaults(e), ["tilt_detected"]);
    assert.equal(getDisplay(e), "OUT OF ORDER");
  });
  it("multiple simultaneous faults", function() {
    var e = buildVendingKB();
    e.queryFirst(sensorEvent("tilt", "tilted"));
    e.queryFirst(sensorEvent("door", "open"));
    var f = getFaults(e);
    assert.ok(f.indexOf("tilt_detected") >= 0);
    assert.ok(f.indexOf("door_open") >= 0);
  });
  it("fault clears when sensor recovers", function() {
    var e = buildVendingKB();
    e.queryFirst(sensorEvent("tilt", "tilted"));
    e.queryFirst(sensorEvent("tilt", "ok"));
    assert.deepEqual(getFaults(e), []);
    assert.equal(getDisplay(e), "INSERT COINS");
  });
});

describe("Faults block vending", function() {
  it("tilt blocks coin insert", function() {
    var e = buildVendingKB();
    e.queryFirst(sensorEvent("tilt", "tilted"));
    e.queryFirst(coinEvent(25));
    assert.equal(getCredit(e), 0); // credit unchanged
  });
  it("tilt blocks vend even with credit", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(125));
    e.queryFirst(sensorEvent("tilt", "tilted"));
    e.queryFirst(selectEvent("a1"));
    assert.equal(getState(e), "idle"); // still idle, not vending
    assert.equal(getCredit(e), 125); // credit unchanged
  });
  it("motor_a1 stuck blocks a1, not a2", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(200));
    e.queryFirst(sensorEvent("motor_a1", "stuck"));
    assert.equal(e.queryFirst(c("can_vend",[at("a1")])), null);
    assert.notEqual(e.queryFirst(c("can_vend",[at("a2")])), null);
  });
  it("delivery blocked stops all vending", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(200));
    e.queryFirst(sensorEvent("delivery", "blocked"));
    assert.deepEqual(getAvailable(e), []);
  });
  it("out of stock one slot, others fine", function() {
    var e = buildVendingKB();
    for (var i = 0; i < 8; i++) {
      e.queryFirst(coinEvent(125));
      e.queryFirst(selectEvent("a1"));
      e.queryFirst(vendCompleteEvent());
    }
    e.queryFirst(coinEvent(125));
    assert.equal(e.queryFirst(c("can_vend",[at("a1")])), null);
    assert.notEqual(e.queryFirst(c("can_vend",[at("a2")])), null);
  });
});

describe("Fault response policy", function() {
  it("tilt → lock_and_alarm", function() {
    var e = buildVendingKB();
    e.queryFirst(sensorEvent("tilt", "tilted"));
    assert.equal(e.queryFirst(c("fault_response",[at("tilt_detected"),v("A")])).args[1].name, "lock_and_alarm");
  });
  it("overtemp → compressor_boost", function() {
    var e = buildVendingKB();
    e.queryFirst(sensorEvent("temp", "hot"));
    assert.equal(e.queryFirst(c("fault_response",[at("overtemp"),v("A")])).args[1].name, "compressor_boost");
  });
  it("power fault with credit → emergency return", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(100));
    e.queryFirst(sensorEvent("power", "low"));
    assert.notEqual(e.queryFirst(c("should_return_credit_on_fault",[])), null);
  });
});

describe("Diagnostics", function() {
  it("reports insufficient credit", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(50));
    assert.equal(e.queryFirst(c("vend_blocked_reason",[at("a1"),v("R")])).args[1].name, "insufficient_credit");
  });
  it("reports fault as reason", function() {
    var e = buildVendingKB();
    e.queryFirst(coinEvent(200));
    e.queryFirst(sensorEvent("door", "open"));
    assert.equal(e.queryFirst(c("vend_blocked_reason",[at("a1"),v("R")])).args[1].name, "has_fault");
  });
});

describe("Reactive layer", function() {
  it("display recomputes on sensor change", function() {
    var e = buildVendingKB();
    var rp = createReactiveEngine(e);
    var display = rp.createQueryFirst(function(){return c("display_message",[v("M")]);});
    assert.equal(display().args[0].name, "INSERT COINS");
    rp.act(sensorEvent("tilt", "tilted"));
    assert.equal(display().args[0].name, "OUT OF ORDER");
    rp.act(sensorEvent("tilt", "ok"));
    assert.equal(display().args[0].name, "INSERT COINS");
  });
  it("available slots update when motor fails", function() {
    var e = buildVendingKB();
    var rp = createReactiveEngine(e);
    rp.act(coinEvent(200));
    var avail = rp.createQueryFirst(function(){return c("available_slots",[v("S")]);});
    var slots = function(){return listToArray(avail().args[0]).map(function(t){return t.name;});};
    assert.ok(slots().indexOf("a1") >= 0);
    rp.act(sensorEvent("motor_a1", "stuck"));
    assert.ok(slots().indexOf("a1") < 0);
    rp.act(sensorEvent("motor_a1", "ready"));
    assert.ok(slots().indexOf("a1") >= 0);
  });
  it("full: insert → tilt → recover → vend", function() {
    var e = buildVendingKB();
    var rp = createReactiveEngine(e);
    var display = rp.createQueryFirst(function(){return c("display_message",[v("M")]);});
    var credit = rp.createQueryFirst(function(){return c("credit",[v("C")]);});
    rp.act(coinEvent(125));
    assert.equal(credit().args[0].value, 125);
    rp.act(sensorEvent("tilt", "tilted"));
    assert.equal(display().args[0].name, "OUT OF ORDER");
    rp.act(selectEvent("a1"));
    assert.equal(getState(e), "idle"); // blocked — still idle
    rp.act(sensorEvent("tilt", "ok"));
    rp.act(selectEvent("a1"));
    assert.equal(credit().args[0].value, 0);
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
