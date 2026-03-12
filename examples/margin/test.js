// ============================================================
// test.js — Margin trading KB tests
//
// Run with ANY JavaScript runtime:
//   qjs --bignum --module examples/margin/test.js
//   node examples/margin/test.js
//   deno run examples/margin/test.js
// ============================================================

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);

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
import { buildMarginKB, updatePrice, updateBalance, addPosition, removePosition, addTrigger, removeTrigger } from "./margin-kb.js";

var at = PrologEngine.atom, v = PrologEngine.variable;
var c = PrologEngine.compound, n = PrologEngine.num;

// ── Query helpers ───────────────────────────────────────────

function getAtom(result, idx) {
  if (!result) return null;
  return result.args[idx].name;
}

function queryVal(e, functor, arity) {
  var args = [];
  for (var i = 0; i < arity; i++) args.push(v("V" + i));
  var r = e.queryFirst(c(functor, args));
  if (!r) return null;
  return r.args[0].name;
}

function getPositionValue(e, sym) {
  var r = e.queryFirst(c("position_value", [at(sym), v("Q"), v("V")]));
  return r ? r.args[2].name : null;
}

function getPnL(e, sym) {
  var r = e.queryFirst(c("unrealized_pnl", [at(sym), v("Q"), v("P")]));
  return r ? r.args[2].name : null;
}

function getTotalEquity(e) {
  var r = e.queryFirst(c("total_equity", [v("E")]));
  return r ? r.args[0].name : null;
}

function getMarginUsed(e) {
  var r = e.queryFirst(c("margin_used", [v("M")]));
  return r ? r.args[0].name : null;
}

function getMarginRatio(e) {
  var r = e.queryFirst(c("margin_ratio", [v("R")]));
  return r ? r.args[0].name : null;
}

function getMarginStatus(e) {
  var r = e.queryFirst(c("margin_status", [v("S")]));
  return r ? r.args[0].name : null;
}

function getDisplayStatus(e) {
  var r = e.queryFirst(c("display_status", [v("S")]));
  return r ? r.args[0].name : null;
}

function getTriggers(e) {
  var r = e.queryFirst(c("active_triggers", [v("Ts")]));
  if (!r) return [];
  var arr = listToArray(r.args[0]);
  return arr.map(function(t) {
    return { sym: t.args[0].name, type: t.args[1].name, action: t.args[2].name };
  });
}

function approx(strVal, expected, tolerance) {
  var val = Number(strVal);
  return Math.abs(val - expected) < (tolerance || 0.01);
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("Position valuation", function() {
  it("BTC position value = qty * price", function() {
    var e = buildMarginKB();
    // 2.5 * 30000 = 75000
    assert.ok(approx(getPositionValue(e, "BTC"), 75000));
  });

  it("ETH position value = qty * price", function() {
    var e = buildMarginKB();
    // 50 * 1900 = 95000
    assert.ok(approx(getPositionValue(e, "ETH"), 95000));
  });

  it("BTC unrealized PnL = qty * (price - entry)", function() {
    var e = buildMarginKB();
    // 2.5 * (30000 - 29500) = 1250
    assert.ok(approx(getPnL(e, "BTC"), 1250));
  });

  it("ETH unrealized PnL", function() {
    var e = buildMarginKB();
    // 50 * (1900 - 1850) = 2500
    assert.ok(approx(getPnL(e, "ETH"), 2500));
  });

  it("total equity = balance + total PnL", function() {
    var e = buildMarginKB();
    // 100000 + 1250 + 2500 = 103750
    assert.ok(approx(getTotalEquity(e), 103750));
  });
});

describe("Margin calculations", function() {
  it("margin used = total_value * requirement / 100", function() {
    var e = buildMarginKB();
    // (75000 + 95000) * 25 / 100 = 42500
    assert.ok(approx(getMarginUsed(e), 42500));
  });

  it("margin ratio = equity / margin_used * 100", function() {
    var e = buildMarginKB();
    // 103750 / 42500 * 100 = 244.11...
    assert.ok(approx(getMarginRatio(e), 244.12, 1));
  });

  it("healthy status when ratio > 150%", function() {
    var e = buildMarginKB();
    assert.equal(getMarginStatus(e), "healthy");
  });

  it("display shows OK when healthy", function() {
    var e = buildMarginKB();
    assert.equal(getDisplayStatus(e), "OK");
  });
});

describe("Price movement triggers", function() {
  it("no triggers at initial prices", function() {
    var e = buildMarginKB();
    assert.deepEqual(getTriggers(e), []);
  });

  it("BTC take_profit fires when price >= 35000", function() {
    var e = buildMarginKB();
    updatePrice(e, "BTC", "35000.00");
    var ts = getTriggers(e);
    var found = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "BTC" && ts[i].type === "take_profit") found = true;
    }
    assert.ok(found, "BTC take_profit should fire");
  });

  it("BTC stop_loss fires when price <= 27000", function() {
    var e = buildMarginKB();
    updatePrice(e, "BTC", "26500.00");
    var ts = getTriggers(e);
    var found = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "BTC" && ts[i].type === "stop_loss") found = true;
    }
    assert.ok(found, "BTC stop_loss should fire");
  });

  it("ETH take_profit fires at 2200", function() {
    var e = buildMarginKB();
    updatePrice(e, "ETH", "2200.00");
    var ts = getTriggers(e);
    var found = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "ETH" && ts[i].type === "take_profit") found = true;
    }
    assert.ok(found, "ETH take_profit should fire");
  });

  it("ETH stop_loss fires at 1600", function() {
    var e = buildMarginKB();
    updatePrice(e, "ETH", "1500.00");
    var ts = getTriggers(e);
    var found = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "ETH" && ts[i].type === "stop_loss") found = true;
    }
    assert.ok(found, "ETH stop_loss should fire");
  });

  it("trigger clears when price recovers", function() {
    var e = buildMarginKB();
    updatePrice(e, "BTC", "26000.00");
    assert.ok(getTriggers(e).length > 0, "trigger should fire");
    updatePrice(e, "BTC", "30000.00");
    var ts = getTriggers(e);
    var btcStop = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "BTC" && ts[i].type === "stop_loss") btcStop = true;
    }
    assert.ok(!btcStop, "BTC stop_loss should clear");
  });
});

describe("Margin status transitions", function() {
  it("warning when ratio drops below 150%", function() {
    var e = buildMarginKB();
    // Need equity/margin_used * 100 between 100 and 150.
    // Crash BTC to lower equity significantly.
    // balance=100000, positions: BTC 2.5, ETH 50
    // At BTC=10000: BTC_val=25000, BTC_pnl=2.5*(10000-29500)=-48750
    // ETH_val=95000, ETH_pnl=2500, total_pnl=-46250
    // equity=53750, margin_used=(25000+95000)*0.25=30000
    // ratio=53750/30000*100=179 — still healthy
    // Try BTC=5000: BTC_val=12500, BTC_pnl=2.5*(5000-29500)=-61250
    // equity=100000+(-61250+2500)=41250, margin_used=(12500+95000)*0.25=26875
    // ratio=41250/26875*100=153 — still healthy
    // Try BTC=4000: BTC_val=10000, BTC_pnl=2.5*(4000-29500)=-63750
    // equity=100000+(-63750+2500)=38750, margin_used=(10000+95000)*0.25=26250
    // ratio=38750/26250*100=147.6 — warning!
    updatePrice(e, "BTC", "4000.00");
    assert.equal(getMarginStatus(e), "warning");
    assert.equal(getDisplayStatus(e), "LOW MARGIN WARNING");
  });

  it("margin_call when ratio drops below 100%", function() {
    var e = buildMarginKB();
    // Need ratio between 50 and 100.
    // BTC=-10000 (impossible), let's use large positions.
    // Add a big position to stress the margin.
    addPosition(e, "SOL", "5000", "100.00");
    updatePrice(e, "SOL", "100.00");
    // SOL: val=500000, pnl=0
    // total_val=75000+95000+500000=670000
    // margin_used=670000*0.25=167500
    // equity=100000+1250+2500+0=103750
    // ratio=103750/167500*100=61.9 — margin_call!
    assert.equal(getMarginStatus(e), "margin_call");
    assert.equal(getDisplayStatus(e), "MARGIN CALL");
  });

  it("margin_call trigger fires for all positions", function() {
    var e = buildMarginKB();
    addPosition(e, "SOL", "5000", "100.00");
    updatePrice(e, "SOL", "100.00");
    var ts = getTriggers(e);
    var mcSyms = [];
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].type === "margin_call") mcSyms.push(ts[i].sym);
    }
    assert.ok(mcSyms.indexOf("BTC") >= 0, "BTC margin_call");
    assert.ok(mcSyms.indexOf("ETH") >= 0, "ETH margin_call");
    assert.ok(mcSyms.indexOf("SOL") >= 0, "SOL margin_call");
  });

  it("liquidation when ratio < 50%", function() {
    var e = buildMarginKB();
    addPosition(e, "SOL", "10000", "100.00");
    updatePrice(e, "SOL", "100.00");
    // SOL: val=1000000, pnl=0
    // total_val=75000+95000+1000000=1170000
    // margin_used=1170000*0.25=292500
    // equity=103750
    // ratio=103750/292500*100=35.5 — liquidation!
    assert.equal(getMarginStatus(e), "liquidation");
    assert.equal(getDisplayStatus(e), "LIQUIDATION WARNING");
  });

  it("liquidation trigger fires", function() {
    var e = buildMarginKB();
    addPosition(e, "SOL", "10000", "100.00");
    updatePrice(e, "SOL", "100.00");
    var ts = getTriggers(e);
    var liqFound = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].type === "liquidation") liqFound = true;
    }
    assert.ok(liqFound, "liquidation trigger should fire");
  });
});

describe("Dynamic state changes", function() {
  it("updating balance changes equity", function() {
    var e = buildMarginKB();
    var eq1 = Number(getTotalEquity(e));
    updateBalance(e, "200000.00");
    var eq2 = Number(getTotalEquity(e));
    assert.ok(approx(String(eq2 - eq1), 100000, 1));
  });

  it("removing a position reduces margin used", function() {
    var e = buildMarginKB();
    var m1 = Number(getMarginUsed(e));
    removePosition(e, "BTC");
    var m2 = Number(getMarginUsed(e));
    assert.ok(m2 < m1, "margin should decrease");
  });

  it("adding a trigger config activates new trigger", function() {
    var e = buildMarginKB();
    // BTC at 30000, add a take_profit at 30000 (should fire immediately)
    addTrigger(e, "BTC", "take_profit", "29000.00");
    var ts = getTriggers(e);
    var found = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "BTC" && ts[i].type === "take_profit") found = true;
    }
    assert.ok(found, "new take_profit trigger should fire");
  });

  it("removing a trigger config disables it", function() {
    var e = buildMarginKB();
    updatePrice(e, "BTC", "36000.00");
    assert.ok(getTriggers(e).length > 0);
    removeTrigger(e, "BTC", "take_profit");
    var ts = getTriggers(e);
    var found = false;
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].sym === "BTC" && ts[i].type === "take_profit") found = true;
    }
    assert.ok(!found, "removed trigger should not fire");
  });
});

describe("Reactive layer", function() {
  it("status recomputes on price change", function() {
    var e = buildMarginKB();
    var rp = createReactiveEngine(e);
    var status = rp.createQueryFirst(function() { return c("display_status", [v("S")]); });
    assert.equal(status().args[0].name, "OK");
    // Crash BTC to trigger warning
    updatePrice(e, "BTC", "4000.00");
    rp.bump();
    assert.equal(status().args[0].name, "LOW MARGIN WARNING");
    // Recover
    updatePrice(e, "BTC", "30000.00");
    rp.bump();
    assert.equal(status().args[0].name, "OK");
  });

  it("triggers recompute reactively", function() {
    var e = buildMarginKB();
    var rp = createReactiveEngine(e);
    var triggers = rp.createQueryFirst(function() { return c("active_triggers", [v("Ts")]); });
    assert.equal(listToArray(triggers().args[0]).length, 0);
    updatePrice(e, "BTC", "36000.00");
    rp.bump();
    var ts = listToArray(triggers().args[0]);
    assert.ok(ts.length > 0, "triggers should fire after price bump");
  });

  it("equity updates reactively with balance change", function() {
    var e = buildMarginKB();
    var rp = createReactiveEngine(e);
    var equity = rp.createQueryFirst(function() { return c("total_equity", [v("E")]); });
    var eq1 = Number(equity().args[0].name);
    updateBalance(e, "200000.00");
    rp.bump();
    var eq2 = Number(equity().args[0].name);
    assert.ok(approx(String(eq2 - eq1), 100000, 1));
  });

  it("effect fires on margin status change", function() {
    var e = buildMarginKB();
    var rp = createReactiveEngine(e);
    var alerts = [];
    rp.onUpdate(function() {
      var s = getMarginStatus(e);
      if (s !== "healthy") alerts.push(s);
    });
    assert.equal(alerts.length, 0);
    updatePrice(e, "BTC", "4000.00");
    rp.bump();
    assert.ok(alerts.length > 0, "alert should fire");
    assert.equal(alerts[alerts.length - 1], "warning");
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
