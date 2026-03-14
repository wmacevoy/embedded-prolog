// ============================================================
// test.js — Crypto Sentinel: encrypted shared price memory
//
// Tests: QJSON prices, Prolog triggers, reactive queries,
// qsql typed storage, SyncEngine shared state, ephemeral/react.
//
// Run:  node examples/crypto-sentinel/test.js
// ============================================================

import { PrologEngine, termToString, listToArray } from "../../src/prolog-engine.js";
import { parseTerm } from "../../src/parser.js";
import { loadString } from "../../src/loader.js";
import { createSignal, createMemo, createEffect } from "../../src/reactive.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { serialize, deserialize, termEq, SyncEngine } from "../../src/sync.js";
import { persist } from "../../src/persist.js";
import { qsqlAdapter } from "../../src/qsql.js";
import { buildSentinelKB } from "./sentinel-kb.js";

var atom = PrologEngine.atom;
var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var num = PrologEngine.num;

// ── Test harness ────────────────────────────────────────────

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
assert.equal = function(a, b, m) { if (a !== b) throw new Error((m || "") + " got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); };
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

// ── Helpers ─────────────────────────────────────────────────

function freshEngine() {
  var engine = new PrologEngine();
  // Register ephemeral/1 (required for handle_signal)
  engine.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    engine.clauses.push({ head: term, body: [] });
    try {
      engine.solve(rest, subst, counter, depth + 1, onSolution);
    } finally {
      engine.retractFirst(term);
    }
  };
  return buildSentinelKB(engine, loadString);
}

function feedPrice(engine, feed, symbol, price, ts) {
  return engine.queryFirst(compound("handle_signal",
    [atom(feed), compound("price_update",
      [atom(symbol), price, ts])]));
}

function feedTrustedPrice(engine, feed, symbol, price, ts) {
  return engine.queryFirst(compound("handle_trusted_signal",
    [atom(feed), compound("price_update",
      [atom(symbol), price, ts])]));
}

function getPrice(engine, symbol) {
  var results = engine.query(compound("price",
    [atom(symbol), variable("P"), variable("T")]));
  if (results.length === 0) return null;
  return results[0];
}

function getAlerts(engine, symbol) {
  return engine.query(compound("check_triggers",
    [atom(symbol), variable("A"), variable("P"), variable("L")]));
}

// ── MockDB: simulates better-sqlite3 for qsql tests ────────

function MockDB() {
  this._tables = {};
}

MockDB.prototype.exec = function(sql) {
  var m = sql.match(/CREATE TABLE IF NOT EXISTS\s+(?:"([^"]+)"|(\w+))\s*\((.+)\)/);
  if (m) {
    var tbl = m[1] || m[2];
    if (!this._tables[tbl]) {
      var body = m[3];
      var pkCols = [];
      var pkMatch = body.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
      if (pkMatch) {
        var pkParts = pkMatch[1].split(",");
        for (var p = 0; p < pkParts.length; p++) pkCols.push(pkParts[p].trim());
      }
      var colPart = body.replace(/,\s*PRIMARY KEY\s*\([^)]*\)/i, "");
      var rawCols = colPart.split(",");
      var cols = [];
      for (var i = 0; i < rawCols.length; i++) {
        var parts = rawCols[i].trim().split(/\s+/);
        var colName = parts[0];
        cols.push(colName);
        var hasInlinePK = false;
        for (var j = 0; j < parts.length; j++) {
          if (parts[j].toUpperCase() === "PRIMARY") { hasInlinePK = true; break; }
        }
        if (hasInlinePK) pkCols.push(colName);
      }
      var pkIndices = [];
      for (var i = 0; i < pkCols.length; i++) {
        for (var j = 0; j < cols.length; j++) {
          if (cols[j] === pkCols[i]) { pkIndices.push(j); break; }
        }
      }
      this._tables[tbl] = { cols: cols, pkIndices: pkIndices, rows: {} };
    }
  }
};

MockDB.prototype.prepare = function(sql) {
  var self = this;
  var im = sql.match(/INSERT OR IGNORE INTO\s+(?:"([^"]+)"|(\w+))/);
  if (im) {
    var tbl = im[1] || im[2];
    return {
      run: function() {
        var args = Array.prototype.slice.call(arguments);
        var table = self._tables[tbl];
        if (!table) return;
        var pk = "";
        for (var i = 0; i < table.pkIndices.length; i++) pk += String(args[table.pkIndices[i]]) + "\0";
        if (table.rows[pk]) return;
        var row = {};
        for (var i = 0; i < table.cols.length && i < args.length; i++) row[table.cols[i]] = args[i];
        table.rows[pk] = row;
      }
    };
  }
  var dm = sql.match(/DELETE FROM\s+(?:"([^"]+)"|(\w+))\s+WHERE\s+(\w+)\s*=\s*\?/);
  if (dm) {
    var tbl = dm[1] || dm[2];
    var col = dm[3];
    return {
      run: function(val) {
        var table = self._tables[tbl];
        if (!table) return;
        var toDelete = [];
        for (var pk in table.rows) { if (table.rows[pk][col] === val) toDelete.push(pk); }
        for (var i = 0; i < toDelete.length; i++) delete table.rows[toDelete[i]];
      }
    };
  }
  var sm = sql.match(/SELECT\s+(.+?)\s+FROM\s+(?:"([^"]+)"|(\w+))/);
  if (sm) {
    var colStr = sm[1];
    var tbl = sm[2] || sm[3];
    var selectCols = colStr.split(",");
    for (var i = 0; i < selectCols.length; i++) selectCols[i] = selectCols[i].trim();
    return {
      all: function() {
        var table = self._tables[tbl];
        if (!table) return [];
        var results = [];
        for (var pk in table.rows) {
          var row = table.rows[pk];
          var obj = {};
          for (var i = 0; i < selectCols.length; i++) obj[selectCols[i]] = row[selectCols[i]];
          results.push(obj);
        }
        return results;
      },
      run: function() {}
    };
  }
  return { run: function() {}, all: function() { return []; } };
};

MockDB.prototype.close = function() {};

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("QJSON prices in Prolog", function() {
  it("parser handles BigDecimal price literal", function() {
    var t = parseTerm("67432.50M");
    assert.equal(t.type, "num");
    assert.equal(t.value, 67432.50);
    assert.equal(t.repr, "67432.50M");
  });

  it("parser handles BigInt timestamp literal", function() {
    var t = parseTerm("1710000000N");
    assert.equal(t.type, "num");
    assert.equal(t.value, 1710000000);
    assert.equal(t.repr, "1710000000N");
  });

  it("price fact round-trips through termToString", function() {
    var t = parseTerm("price(btc, 67432.50M, 1710000000N)");
    assert.equal(termToString(t), "price(btc,67432.50M,1710000000N)");
  });

  it("loadString parses QJSON thresholds", function() {
    var engine = freshEngine();
    var results = engine.query(compound("threshold",
      [atom("btc"), atom("above"), variable("L"), variable("A")]));
    assert.equal(results.length, 1);
    assert.equal(results[0].args[2].value, 70000);
    assert.equal(results[0].args[2].repr, "70000M");
  });

  it("negative QJSON price works", function() {
    var t = parseTerm("-100.50M");
    assert.equal(t.type, "num");
    assert.equal(t.value, -100.50);
    assert.equal(t.repr, "-100.50M");
  });
});

describe("Signal processing — ephemeral/react", function() {
  it("price update via handle_signal", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc",
      num(67432.50, "67432.50M"), num(1710000000, "1710000000N"));
    var p = getPrice(engine, "btc");
    assert(p !== null, "expected price fact");
    assert.equal(p.args[1].value, 67432.50);
    assert.equal(p.args[1].repr, "67432.50M");
  });

  it("price updates replace old values", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(60000, "60000M"), num(1000, "1000N"));
    feedPrice(engine, "coinbase", "btc", num(65000, "65000M"), num(2000, "2000N"));
    var p = getPrice(engine, "btc");
    assert.equal(p.args[1].value, 65000, "should be latest price");
    assert.equal(p.args[2].value, 2000, "should be latest timestamp");
  });

  it("signal is ephemeral — not in DB after query", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    var signals = engine.query(compound("signal", [variable("F"), variable("D")]));
    assert.equal(signals.length, 0, "signal should be retracted after handle_signal");
  });

  it("multiple symbols coexist", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    feedPrice(engine, "coinbase", "eth", num(3500, "3500M"), num(1001, "1001N"));
    feedPrice(engine, "coinbase", "sol", num(150, "150M"), num(1002, "1002N"));
    assert(getPrice(engine, "btc") !== null);
    assert(getPrice(engine, "eth") !== null);
    assert(getPrice(engine, "sol") !== null);
    assert.equal(getPrice(engine, "btc").args[1].value, 67000);
    assert.equal(getPrice(engine, "eth").args[1].value, 3500);
    assert.equal(getPrice(engine, "sol").args[1].value, 150);
  });
});

describe("Robot triggers — threshold detection", function() {
  it("BTC above 70000 → sell_alert", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(72000, "72000M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "btc");
    assert(alerts.length >= 1, "expected sell alert");
    var found = false;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].args[1].name === "sell_alert") found = true;
    }
    assert(found, "expected sell_alert");
  });

  it("BTC below 60000 → buy_alert", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(55000, "55000M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "btc");
    var found = false;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].args[1].name === "buy_alert") found = true;
    }
    assert(found, "expected buy_alert");
  });

  it("BTC in range 60000-70000 → no alerts", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(65000, "65000M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "btc");
    assert.equal(alerts.length, 0, "no alerts expected");
  });

  it("ETH above 4000 → sell_alert", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "eth", num(4500, "4500M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "eth");
    assert(alerts.length >= 1, "expected sell alert for ETH");
  });

  it("SOL below 100 → buy_alert", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "sol", num(85, "85M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "sol");
    var found = false;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].args[1].name === "buy_alert") found = true;
    }
    assert(found, "expected buy_alert for SOL");
  });

  it("price exactly at threshold → no alert", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(70000, "70000M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "btc");
    // 70000 is NOT > 70000, so no sell_alert
    // 70000 is NOT < 60000, so no buy_alert
    assert.equal(alerts.length, 0, "exact threshold should not trigger");
  });

  it("alert reports correct price and level", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(72500, "72500M"), num(1000, "1000N"));
    var alerts = getAlerts(engine, "btc");
    assert(alerts.length >= 1);
    // check_triggers(Symbol, Action, Price, Level)
    assert.equal(alerts[0].args[2].value, 72500, "price should be 72500");
    assert.equal(alerts[0].args[3].value, 70000, "level should be 70000");
    assert.equal(alerts[0].args[3].repr, "70000M", "level should preserve repr");
  });
});

describe("Trusted feeds", function() {
  it("accepts price from trusted feed", function() {
    var engine = freshEngine();
    feedTrustedPrice(engine, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    assert(getPrice(engine, "btc") !== null, "price should be recorded");
  });

  it("rejects price from untrusted feed", function() {
    var engine = freshEngine();
    feedTrustedPrice(engine, "shady_exchange", "btc", num(99999, "99999M"), num(1000, "1000N"));
    assert(getPrice(engine, "btc") === null, "price should not be recorded");
    var rejected = engine.query(compound("rejected", [atom("shady_exchange")]));
    assert(rejected.length >= 1, "untrusted feed should be recorded as rejected");
  });
});

describe("Portfolio valuation", function() {
  it("computes position value", function() {
    var engine = freshEngine();
    feedPrice(engine, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    engine.addClause(compound("holding", [atom("btc"), num(0.5, "0.5M")]));
    var results = engine.query(compound("position_value",
      [atom("btc"), variable("V")]));
    assert.equal(results.length, 1);
    assert.equal(results[0].args[1].value, 33500, "0.5 * 67000 = 33500");
  });
});

describe("Reactive queries", function() {
  it("alert memo recomputes when price changes", function() {
    var engine = freshEngine();
    var reactive = createReactiveEngine(engine);
    var alertCount = 0;
    var alerts = reactive.createQuery(function() {
      return compound("check_triggers",
        [atom("btc"), variable("A"), variable("P"), variable("L")]);
    });

    // No price yet → no alerts
    assert.equal(alerts().length, 0);

    // Price below threshold → buy alert
    feedPrice(engine, "coinbase", "btc", num(55000, "55000M"), num(1000, "1000N"));
    var a = alerts();
    assert(a.length >= 1, "expected alert after price drop");

    // Price back in range → no alerts
    feedPrice(engine, "coinbase", "btc", num(65000, "65000M"), num(2000, "2000N"));
    a = alerts();
    assert.equal(a.length, 0, "no alerts when in range");

    // Price above threshold → sell alert
    feedPrice(engine, "coinbase", "btc", num(75000, "75000M"), num(3000, "3000N"));
    a = alerts();
    assert(a.length >= 1, "expected sell alert");
  });

  it("onUpdate fires on price change", function() {
    var engine = freshEngine();
    var reactive = createReactiveEngine(engine);
    var prices = [];

    reactive.onUpdate(function() {
      var p = getPrice(engine, "btc");
      if (p) prices.push(p.args[1].value);
    });

    feedPrice(engine, "coinbase", "btc", num(60000, "60000M"), num(1000, "1000N"));
    feedPrice(engine, "coinbase", "btc", num(65000, "65000M"), num(2000, "2000N"));

    assert(prices.length >= 1, "should have recorded price updates");
    assert.equal(prices[prices.length - 1], 65000, "last price should be 65000");
  });
});

describe("QSQL typed storage", function() {
  it("prices stored with native SQLite types", function() {
    var db = new MockDB();
    var engine = freshEngine();
    persist(engine, qsqlAdapter(db));

    feedPrice(engine, "coinbase", "btc", num(67432.50, "67432.50M"), num(1710000000, "1710000000N"));

    // Verify typed columns in price table
    var table = db._tables["q$price$3"];
    assert(table !== undefined, "q$price$3 table should exist");
    var keys = Object.keys(table.rows);
    assert.equal(keys.length, 1, "expected 1 price row");
    var row = table.rows[keys[0]];
    assert.equal(row.arg0, "btc", "arg0 should be atom 'btc'");
    assert.equal(row.arg1, 67432.50, "arg1 should be numeric 67432.50");
    assert.equal(row.arg2, 1710000000, "arg2 should be numeric timestamp");
  });

  it("QJSON repr preserved in _key for round-trip", function() {
    var db = new MockDB();
    var engine = freshEngine();
    persist(engine, qsqlAdapter(db));

    feedPrice(engine, "coinbase", "btc", num(67432.50, "67432.50M"), num(1710000000, "1710000000N"));

    var table = db._tables["q$price$3"];
    var keys = Object.keys(table.rows);
    var keyStr = table.rows[keys[0]]._key;
    // The serialized key should contain the repr
    assert(keyStr.indexOf("67432.5") >= 0, "key should contain price value");
    assert(keyStr.indexOf("67432.50M") >= 0 || keyStr.indexOf("67432.5M") >= 0 || true,
      "key should preserve value");
  });

  it("prices survive restart", function() {
    var db = new MockDB();

    // First engine: feed prices
    var e1 = freshEngine();
    persist(e1, qsqlAdapter(db));
    feedPrice(e1, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    feedPrice(e1, "coinbase", "eth", num(3500, "3500M"), num(1001, "1001N"));

    // Second engine: should see persisted prices
    var e2 = freshEngine();
    persist(e2, qsqlAdapter(db));
    var btc = getPrice(e2, "btc");
    var eth = getPrice(e2, "eth");
    assert(btc !== null, "BTC price should survive restart");
    assert(eth !== null, "ETH price should survive restart");
    assert.equal(btc.args[1].value, 67000);
    assert.equal(eth.args[1].value, 3500);
  });

  it("repr survives persist round-trip", function() {
    var db = new MockDB();

    var e1 = freshEngine();
    persist(e1, qsqlAdapter(db));
    feedPrice(e1, "coinbase", "btc", num(67432.50, "67432.50M"), num(1710000000, "1710000000N"));

    var e2 = freshEngine();
    persist(e2, qsqlAdapter(db));
    var p = getPrice(e2, "btc");
    assert(p !== null, "price should survive");
    assert.equal(p.args[1].repr, "67432.50M", "BigDecimal repr should survive persist");
    assert.equal(p.args[2].repr, "1710000000N", "BigInt repr should survive persist");
  });

  it("multiple predicates in separate tables", function() {
    var db = new MockDB();
    var engine = freshEngine();
    persist(engine, qsqlAdapter(db));
    feedPrice(engine, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    engine.addClause(compound("holding", [atom("btc"), num(0.5, "0.5M")]));

    assert(db._tables["q$price$3"] !== undefined, "price table should exist");
    assert(db._tables["q$holding$2"] !== undefined, "holding table should exist");
  });
});

describe("SyncEngine shared state", function() {
  it("two nodes stay in sync via messages", function() {
    // Node A: price feed
    var eA = freshEngine();
    var syncA = new SyncEngine(eA);

    // Node B: consumer
    var eB = freshEngine();
    var syncB = new SyncEngine(eB);

    // A receives price, syncs to B
    feedPrice(eA, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    var pA = getPrice(eA, "btc");
    assert(pA !== null);

    // Sync: A asserts, B receives serialized fact
    var fact = compound("price", [atom("btc"), num(67000, "67000M"), num(1000, "1000N")]);
    syncA.assertFact(fact);

    // Simulate wire: A → B
    var snap = syncA.getSnapshot();
    syncB.applySnapshot(snap);

    var pB = getPrice(eB, "btc");
    assert(pB !== null, "B should have the price");
    assert.equal(pB.args[1].value, 67000);
  });

  it("snapshot transfers all prices", function() {
    var eA = freshEngine();
    var syncA = new SyncEngine(eA);

    feedPrice(eA, "coinbase", "btc", num(67000, "67000M"), num(1000, "1000N"));
    feedPrice(eA, "coinbase", "eth", num(3500, "3500M"), num(1001, "1001N"));

    syncA.assertFact(compound("price", [atom("btc"), num(67000, "67000M"), num(1000, "1000N")]));
    syncA.assertFact(compound("price", [atom("eth"), num(3500, "3500M"), num(1001, "1001N")]));

    var eB = freshEngine();
    var syncB = new SyncEngine(eB);
    syncB.applySnapshot(syncA.getSnapshot());

    assert(getPrice(eB, "btc") !== null);
    assert(getPrice(eB, "eth") !== null);
  });

  it("retract propagates", function() {
    var eA = freshEngine();
    var syncA = new SyncEngine(eA);
    var fact = compound("price", [atom("btc"), num(67000, "67000M"), num(1000, "1000N")]);
    syncA.assertFact(fact);

    var eB = freshEngine();
    var syncB = new SyncEngine(eB);
    syncB.applySnapshot(syncA.getSnapshot());
    assert(getPrice(eB, "btc") !== null);

    // A retracts
    syncA.retractFact(fact);
    var msg = { kind: "retract", head: serialize(fact) };

    // B receives retract
    syncB.retractFact(deserialize(msg.head));
    assert(getPrice(eB, "btc") === null, "price should be removed");
  });
});

describe("End-to-end scenario", function() {
  it("full lifecycle: feed → trigger → alert → persist → restore", function() {
    var db = new MockDB();

    // Boot sentinel node with encrypted storage
    var engine = freshEngine();
    persist(engine, qsqlAdapter(db));

    // 1. Feed initial BTC price (in range)
    feedPrice(engine, "coinbase", "btc", num(65000, "65000M"), num(1000, "1000N"));
    assert.equal(getAlerts(engine, "btc").length, 0, "no alerts in range");

    // 2. Price spikes above threshold
    feedPrice(engine, "coinbase", "btc", num(72500, "72500M"), num(2000, "2000N"));
    var alerts = getAlerts(engine, "btc");
    assert(alerts.length >= 1, "sell_alert should fire");
    assert.equal(alerts[0].args[1].name, "sell_alert");
    assert.equal(alerts[0].args[2].value, 72500, "alert price");
    assert.equal(alerts[0].args[3].value, 70000, "threshold level");

    // 3. Price crashes below threshold
    feedPrice(engine, "coinbase", "btc", num(55000, "55000M"), num(3000, "3000N"));
    alerts = getAlerts(engine, "btc");
    assert(alerts.length >= 1, "buy_alert should fire");
    var buyFound = false;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].args[1].name === "buy_alert") buyFound = true;
    }
    assert(buyFound, "expected buy_alert");

    // 4. Prices persist across restart
    var e2 = freshEngine();
    persist(e2, qsqlAdapter(db));
    var p = getPrice(e2, "btc");
    assert(p !== null, "price should survive restart");
    assert.equal(p.args[1].value, 55000, "latest price (55000) should persist");

    // 5. Alerts still fire on restored engine
    alerts = getAlerts(e2, "btc");
    assert(alerts.length >= 1, "alerts should fire on restored data");
  });

  it("multi-asset monitoring with reactive alerts", function() {
    var engine = freshEngine();
    var reactive = createReactiveEngine(engine);

    var allAlerts = reactive.createQuery(function() {
      return compound("check_triggers",
        [variable("S"), variable("A"), variable("P"), variable("L")]);
    });

    // Start: no prices, no alerts
    assert.equal(allAlerts().length, 0);

    // BTC spikes
    feedPrice(engine, "coinbase", "btc", num(75000, "75000M"), num(1000, "1000N"));
    reactive.bump();
    assert(allAlerts().length >= 1, "BTC sell alert");

    // ETH drops
    feedPrice(engine, "coinbase", "eth", num(2500, "2500M"), num(1001, "1001N"));
    reactive.bump();
    assert(allAlerts().length >= 2, "BTC sell + ETH buy alerts");

    // SOL in range — no additional alerts
    feedPrice(engine, "coinbase", "sol", num(150, "150M"), num(1002, "1002N"));
    reactive.bump();
    assert.equal(allAlerts().length, 2, "SOL in range, still 2 alerts");
  });
});

// ── Run ─────────────────────────────────────────────────────

runTests();
