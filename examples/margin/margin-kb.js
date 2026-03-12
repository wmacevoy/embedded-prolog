// ============================================================
// Margin Trading Knowledge Base
//
// Triggered margin buy/sell with precise decimal arithmetic.
// Designed for QuickJS --bignum (BigDecimal) but falls back
// to Number on any other JS runtime.
//
// Dynamic state (via assert/retract):
//   account_balance(V)        — cash balance (decimal string)
//   position(Symbol,Qty,Entry)— open position
//   price(Symbol,V)           — current market price
//   margin_requirement(Pct)   — maintenance margin % (e.g. "25")
//
// Derived (rules):
//   position_value/3, unrealized_pnl/3, total_equity/1,
//   margin_used/1, margin_ratio/1, margin_status/1,
//   trigger/3 — fires buy/sell/liquidate/take_profit/stop_loss
//
// Custom builtins (registered on engine):
//   bd_is(Result, Expr)       — BigDecimal arithmetic
//   bd_gt(A, B), bd_lt(A, B), bd_gte(A, B), bd_lte(A, B)
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
var at = PrologEngine.atom, v = PrologEngine.variable;
var c = PrologEngine.compound, n = PrologEngine.num;

// ── BigDecimal / Number adapter ──────────────────────────────

var _hasBD = false;
try { _hasBD = (typeof BigDecimal !== "undefined"); } catch(e) {}

function _toBD(s) {
  if (_hasBD) return BigDecimal(s);
  return Number(s);
}

function _bdStr(x) {
  return String(x);
}

function _bdEval(term) {
  if (!term) return null;
  if (term.type === "atom") {
    var v = _toBD(term.name);
    if (_hasBD) return v;
    if (isNaN(v)) return null;
    return v;
  }
  if (term.type === "num") return _toBD(String(term.value));
  if (term.type === "compound") {
    var f = term.functor, a = term.args;
    if (f === "+" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      return (x !== null && y !== null) ? x + y : null;
    }
    if (f === "-" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      return (x !== null && y !== null) ? x - y : null;
    }
    if (f === "*" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      return (x !== null && y !== null) ? x * y : null;
    }
    if (f === "/" && a.length === 2) {
      var x = _bdEval(a[0]), y = _bdEval(a[1]);
      if (x === null || y === null) return null;
      if (_hasBD) return BigDecimal.div(x, y, { maximumFractionDigits: 8, roundingMode: "half-even" });
      return y !== 0 ? x / y : null;
    }
    if (f === "-" && a.length === 1) {
      var x = _bdEval(a[0]);
      return x !== null ? -x : null;
    }
    if (f === "abs" && a.length === 1) {
      var x = _bdEval(a[0]);
      if (x === null) return null;
      return x < _toBD("0") ? -x : x;
    }
  }
  return null;
}

// ── Register BigDecimal builtins on engine ────────────────────

function registerBDBuiltins(engine) {
  var self = engine;

  // bd_is(Result, Expr) — evaluate Expr with BigDecimal, unify as atom
  self.builtins["bd_is/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var lhs = goal.args[0];
    var rhs = self.deepWalk(goal.args[1], subst);
    var val = _bdEval(rhs);
    if (val !== null) {
      var s = self.unify(lhs, at(_bdStr(val)), subst);
      if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
    }
  };

  // comparison builtins
  var bdComps = [
    ["bd_gt/2",  function(a,b) { return a > b; }],
    ["bd_lt/2",  function(a,b) { return a < b; }],
    ["bd_gte/2", function(a,b) { return a >= b; }],
    ["bd_lte/2", function(a,b) { return a <= b; }]
  ];
  for (var i = 0; i < bdComps.length; i++) {
    (function(op, fn) {
      self.builtins[op] = function(goal, rest, subst, counter, depth, onSolution) {
        var a = _bdEval(self.deepWalk(goal.args[0], subst));
        var b = _bdEval(self.deepWalk(goal.args[1], subst));
        if (a !== null && b !== null && fn(a, b))
          self.solve(rest, subst, counter, depth + 1, onSolution);
      };
    })(bdComps[i][0], bdComps[i][1]);
  }
}

// ── Build the knowledge base ─────────────────────────────────

function buildMarginKB() {
  var e = new PrologEngine();
  registerBDBuiltins(e);

  // ── Initial account state ────────────────────────────────
  e.addClause(c("account_balance", [at("100000.00")]));
  e.addClause(c("margin_requirement", [at("25")]));

  // ── Sample positions ─────────────────────────────────────
  // position(Symbol, Qty, EntryPrice)
  e.addClause(c("position", [at("BTC"), at("2.5"), at("29500.00")]));
  e.addClause(c("position", [at("ETH"), at("50"), at("1850.00")]));

  // ── Initial prices ───────────────────────────────────────
  e.addClause(c("price", [at("BTC"), at("30000.00")]));
  e.addClause(c("price", [at("ETH"), at("1900.00")]));

  // ── Triggers (static config) ─────────────────────────────
  // trigger_config(Symbol, Type, ThresholdPrice)
  e.addClause(c("trigger_config", [at("BTC"), at("take_profit"), at("35000.00")]));
  e.addClause(c("trigger_config", [at("BTC"), at("stop_loss"), at("27000.00")]));
  e.addClause(c("trigger_config", [at("ETH"), at("take_profit"), at("2200.00")]));
  e.addClause(c("trigger_config", [at("ETH"), at("stop_loss"), at("1600.00")]));

  // ── Derived: position_value(Symbol, Qty, Value) ──────────
  // Value = Qty * CurrentPrice
  e.addClause(c("position_value", [v("Sym"), v("Qty"), v("Val")]), [
    c("position", [v("Sym"), v("Qty"), v("_Entry")]),
    c("price", [v("Sym"), v("Price")]),
    c("bd_is", [v("Val"), c("*", [v("Qty"), v("Price")])])
  ]);

  // ── Derived: unrealized_pnl(Symbol, Qty, PnL) ───────────
  // PnL = Qty * (CurrentPrice - EntryPrice)
  e.addClause(c("unrealized_pnl", [v("Sym"), v("Qty"), v("PnL")]), [
    c("position", [v("Sym"), v("Qty"), v("Entry")]),
    c("price", [v("Sym"), v("Price")]),
    c("bd_is", [v("Diff"), c("-", [v("Price"), v("Entry")])]),
    c("bd_is", [v("PnL"), c("*", [v("Qty"), v("Diff")])])
  ]);

  // ── Derived: total_positions_value(V) ────────────────────
  // Sum of all position values. Uses findall + sum helper.
  e.addClause(c("total_positions_value", [v("Total")]), [
    c("findall", [v("V"), c("position_value", [v("_S"), v("_Q"), v("V")]), v("Vals")]),
    c("bd_sum_list", [v("Vals"), v("Total")])
  ]);

  // ── Derived: total_pnl(PnL) ─────────────────────────────
  e.addClause(c("total_pnl", [v("Total")]), [
    c("findall", [v("P"), c("unrealized_pnl", [v("_S"), v("_Q"), v("P")]), v("PnLs")]),
    c("bd_sum_list", [v("PnLs"), v("Total")])
  ]);

  // ── Derived: total_equity(E) ─────────────────────────────
  // Equity = Balance + TotalPnL
  e.addClause(c("total_equity", [v("Eq")]), [
    c("account_balance", [v("Bal")]),
    c("total_pnl", [v("PnL")]),
    c("bd_is", [v("Eq"), c("+", [v("Bal"), v("PnL")])])
  ]);

  // ── Derived: margin_used(M) ──────────────────────────────
  // margin_used = total_positions_value * margin_requirement / 100
  e.addClause(c("margin_used", [v("M")]), [
    c("total_positions_value", [v("TV")]),
    c("margin_requirement", [v("Pct")]),
    c("bd_is", [v("Raw"), c("*", [v("TV"), v("Pct")])]),
    c("bd_is", [v("M"), c("/", [v("Raw"), at("100")])])
  ]);

  // ── Derived: margin_ratio(R) ─────────────────────────────
  // ratio = equity / margin_used * 100 (as percentage)
  e.addClause(c("margin_ratio", [v("R")]), [
    c("total_equity", [v("Eq")]),
    c("margin_used", [v("M")]),
    c("bd_gt", [v("M"), at("0")]),
    c("bd_is", [v("Raw"), c("*", [v("Eq"), at("100")])]),
    c("bd_is", [v("R"), c("/", [v("Raw"), v("M")])])
  ]);

  // ── Derived: margin_status(Status) ───────────────────────
  // healthy: ratio >= 150%
  // warning: 100% <= ratio < 150%
  // margin_call: 50% <= ratio < 100%
  // liquidation: ratio < 50%
  e.addClause(c("margin_status", [at("liquidation")]), [
    c("margin_ratio", [v("R")]),
    c("bd_lt", [v("R"), at("50")])
  ]);
  e.addClause(c("margin_status", [at("margin_call")]), [
    c("margin_ratio", [v("R")]),
    c("bd_gte", [v("R"), at("50")]),
    c("bd_lt", [v("R"), at("100")])
  ]);
  e.addClause(c("margin_status", [at("warning")]), [
    c("margin_ratio", [v("R")]),
    c("bd_gte", [v("R"), at("100")]),
    c("bd_lt", [v("R"), at("150")])
  ]);
  e.addClause(c("margin_status", [at("healthy")]), [
    c("margin_ratio", [v("R")]),
    c("bd_gte", [v("R"), at("150")])
  ]);

  // ── Triggers: trigger(Symbol, Type, Action) ──────────────
  // take_profit: price >= threshold → sell
  e.addClause(c("trigger", [v("Sym"), at("take_profit"), at("sell")]), [
    c("trigger_config", [v("Sym"), at("take_profit"), v("Thresh")]),
    c("price", [v("Sym"), v("Price")]),
    c("bd_gte", [v("Price"), v("Thresh")])
  ]);

  // stop_loss: price <= threshold → sell
  e.addClause(c("trigger", [v("Sym"), at("stop_loss"), at("sell")]), [
    c("trigger_config", [v("Sym"), at("stop_loss"), v("Thresh")]),
    c("price", [v("Sym"), v("Price")]),
    c("bd_lte", [v("Price"), v("Thresh")])
  ]);

  // margin_call trigger: margin_status is margin_call → reduce_position
  e.addClause(c("trigger", [v("Sym"), at("margin_call"), at("reduce_position")]), [
    c("margin_status", [at("margin_call")]),
    c("position", [v("Sym"), v("_Q"), v("_E")])
  ]);

  // liquidation trigger: margin_status is liquidation → liquidate
  e.addClause(c("trigger", [v("Sym"), at("liquidation"), at("liquidate")]), [
    c("margin_status", [at("liquidation")]),
    c("position", [v("Sym"), v("_Q"), v("_E")])
  ]);

  // ── All active triggers ──────────────────────────────────
  e.addClause(c("active_triggers", [v("Ts")]), [
    c("findall",
      [c("t", [v("S"), v("Ty"), v("A")]),
       c("trigger", [v("S"), v("Ty"), v("A")]),
       v("Ts")])
  ]);

  // ── Display status ───────────────────────────────────────
  e.addClause(c("display_status", [at("LIQUIDATION WARNING")]), [
    c("margin_status", [at("liquidation")])
  ]);
  e.addClause(c("display_status", [at("MARGIN CALL")]), [
    c("margin_status", [at("margin_call")])
  ]);
  e.addClause(c("display_status", [at("LOW MARGIN WARNING")]), [
    c("margin_status", [at("warning")])
  ]);
  e.addClause(c("display_status", [at("OK")]), [
    c("margin_status", [at("healthy")])
  ]);

  // ── bd_sum_list builtin ──────────────────────────────────
  // Sums a Prolog list of decimal-atom values
  e.builtins["bd_sum_list/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var list = e.deepWalk(goal.args[0], subst);
    var out = goal.args[1];
    var sum = _toBD("0");
    while (list && list.type === "compound" && list.functor === "." && list.args.length === 2) {
      var item = e.deepWalk(list.args[0], subst);
      var val = _bdEval(item);
      if (val !== null) sum = sum + val;
      list = e.deepWalk(list.args[1], subst);
    }
    var s = e.unify(out, at(_bdStr(sum)), subst);
    if (s !== null) e.solve(rest, s, counter, depth + 1, onSolution);
  };

  return e;
}

// ── Helpers ──────────────────────────────────────────────────

function updatePrice(engine, symbol, price) {
  engine.retractFirst(c("price", [at(symbol), v("_")]));
  engine.addClause(c("price", [at(symbol), at(price)]));
}

function updateBalance(engine, balance) {
  engine.retractFirst(c("account_balance", [v("_")]));
  engine.addClause(c("account_balance", [at(balance)]));
}

function addPosition(engine, symbol, qty, entry) {
  engine.addClause(c("position", [at(symbol), at(qty), at(entry)]));
}

function removePosition(engine, symbol) {
  engine.retractFirst(c("position", [at(symbol), v("_Q"), v("_E")]));
}

function addTrigger(engine, symbol, type, threshold) {
  engine.addClause(c("trigger_config", [at(symbol), at(type), at(threshold)]));
}

function removeTrigger(engine, symbol, type) {
  engine.retractFirst(c("trigger_config", [at(symbol), at(type), v("_")]));
}

if (typeof exports !== "undefined") {
  exports.buildMarginKB = buildMarginKB;
  exports.updatePrice = updatePrice;
  exports.updateBalance = updateBalance;
  exports.addPosition = addPosition;
  exports.removePosition = removePosition;
  exports.addTrigger = addTrigger;
  exports.removeTrigger = removeTrigger;
  exports.registerBDBuiltins = registerBDBuiltins;
}
export {
  buildMarginKB, updatePrice, updateBalance,
  addPosition, removePosition,
  addTrigger, removeTrigger, registerBDBuiltins
};
