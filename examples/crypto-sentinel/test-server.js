// ============================================================
// test-server.js — Tests for the Crypto Sentinel HTTP handler
//
// No HTTP.  Calls handleRequest directly.
//
// Run:  node examples/crypto-sentinel/test-server.js
// ============================================================

import { PrologEngine, termToString } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { createHandler, _jsonToTerm, _termToJson } from "../../src/serve.js";
import { fossilize, mineralize } from "../../src/fossilize.js";
import { buildSentinelKB } from "./sentinel-kb.js";

// ── Test harness ────────────────────────────────────────────

var _print = console.log.bind(console);
var _suites = [];
var _current = null;

function describe(name, fn) {
  var s = { name: name, tests: [], pass: 0, fail: 0 };
  _suites.push(s);
  _current = s;
  fn();
  _current = null;
}

function it(name, fn) { _current.tests.push({ name: name, fn: fn }); }

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
assert.equal = function(a, b, m) { if (a !== b) throw new Error((m || "") + " got " + JSON.stringify(a) + ", want " + JSON.stringify(b)); };

function runTests() {
  var totalPass = 0, totalFail = 0;
  for (var si = 0; si < _suites.length; si++) {
    var suite = _suites[si];
    _print("  " + suite.name);
    for (var ti = 0; ti < suite.tests.length; ti++) {
      var test = suite.tests[ti];
      try { test.fn(); suite.pass++; totalPass++; _print("    \u2713 " + test.name); }
      catch (e) { suite.fail++; totalFail++; _print("    \u2717 " + test.name); _print("      " + (e.message || e)); }
    }
  }
  _print("\n  " + totalPass + " passing, " + totalFail + " failing\n");
  if (totalFail > 0 && typeof process !== "undefined" && process.exit) process.exit(1);
}

// ── Build server (no HTTP) ──────────────────────────────────

function buildServer() {
  var engine = new PrologEngine();
  var reactive = createReactiveEngine(engine);
  buildSentinelKB(engine, loadString);

  loadString(engine,
    // Health check
    "handle(get, '/api/health', _Body1, response(200, ok)).\n" +

    // Reject untrusted feeds FIRST (queryFirst picks first match)
    "handle(post, '/api/price', Body, response(403, rejected)) :- " +
    "  field(Body, feed, Feed), " +
    "  \\+ trusted_feed(Feed).\n" +

    // Feed price from trusted source → return ok
    "handle(post, '/api/price', Body, response(200, ok)) :- " +
    "  field(Body, feed, Feed), " +
    "  field(Body, symbol, Symbol), " +
    "  field(Body, price, Price), " +
    "  field(Body, timestamp, Ts), " +
    "  handle_trusted_signal(Feed, price_update(Symbol, Price, Ts)).\n" +

    // Get price by symbol
    "handle(get, Path, _Body2, response(200, obj([symbol-Symbol, price-Price, timestamp-Ts]))) :- " +
    "  path_segments(Path, [api, price, Symbol]), " +
    "  price(Symbol, Price, Ts).\n" +

    // Price not found
    "handle(get, Path, _Body3, response(404, not_found)) :- " +
    "  path_segments(Path, [api, price, _Sym]).\n" +

    // All alerts
    "handle(get, '/api/alerts', _Body4, response(200, Alerts)) :- " +
    "  findall(alert(S, A, P, L), check_triggers(S, A, P, L), Alerts).\n" +

    // Alerts by symbol
    "handle(get, Path, _Body5, response(200, Alerts)) :- " +
    "  path_segments(Path, [api, alerts, Symbol]), " +
    "  findall(alert(Symbol, A, P, L), check_triggers(Symbol, A, P, L), Alerts).\n"
  );

  var auditLog = [];

  var handler = createHandler(engine, {
    onSends: function(sends, req) {
      for (var i = 0; i < sends.length; i++) {
        auditLog.push({ method: req.method, path: req.path, send: sends[i] });
      }
    }
  });

  return { engine: engine, handler: handler, auditLog: auditLog };
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("JSON ↔ Prolog term conversion", function() {
  it("string → atom", function() {
    var t = _jsonToTerm("hello");
    assert.equal(t.type, "atom");
    assert.equal(t.name, "hello");
  });

  it("number → num", function() {
    var t = _jsonToTerm(42);
    assert.equal(t.type, "num");
    assert.equal(t.value, 42);
  });

  it("boolean → atom", function() {
    assert.equal(_jsonToTerm(true).name, "true");
    assert.equal(_jsonToTerm(false).name, "false");
  });

  it("null → atom(null)", function() {
    assert.equal(_jsonToTerm(null).name, "null");
  });

  it("array → Prolog list", function() {
    var t = _jsonToTerm([1, 2, 3]);
    assert.equal(t.type, "compound");
    assert.equal(t.functor, ".");
  });

  it("object → obj([k:v, ...])", function() {
    var t = _jsonToTerm({ name: "Alice", age: 30 });
    assert.equal(t.type, "compound");
    assert.equal(t.functor, "obj");
  });

  it("round-trip object", function() {
    var orig = { name: "Alice", score: 42 };
    var t = _jsonToTerm(orig);
    var back = _termToJson(t);
    assert.equal(back.name, "Alice");
    assert.equal(back.score, 42);
  });

  it("round-trip array", function() {
    var orig = [1, "two", true, null];
    var t = _jsonToTerm(orig);
    var back = _termToJson(t);
    assert.equal(back.length, 4);
    assert.equal(back[0], 1);
    assert.equal(back[1], "two");
    assert.equal(back[2], true);
    assert.equal(back[3], null);
  });

  it("QJSON BigDecimal string → num with repr", function() {
    var t = _jsonToTerm("67000M");
    assert.equal(t.type, "num");
    assert.equal(t.value, 67000);
    assert.equal(t.repr, "67000M");
  });
});

describe("Request routing", function() {
  it("GET /api/health → 200", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("GET", "/api/health", null);
    assert.equal(res.status, 200);
    var body = JSON.parse(res.body);
    assert.equal(body, "ok");
  });

  it("GET /nonexistent → 404", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("GET", "/nonexistent", null);
    assert.equal(res.status, 404);
  });

  it("POST /api/price with trusted feed → 200", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 67000, timestamp: 1000 });
    assert.equal(res.status, 200);
  });

  it("POST /api/price with untrusted feed → 403", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("POST", "/api/price",
      { feed: "shady", symbol: "btc", price: 99999, timestamp: 1000 });
    assert.equal(res.status, 403);
  });

  it("GET /api/price/btc after feed → price returned", function() {
    var s = buildServer();
    s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 67000, timestamp: 1000 });
    var res = s.handler.handleRequest("GET", "/api/price/btc", null);
    assert.equal(res.status, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.symbol, "btc");
    assert.equal(body.price, 67000);
  });

  it("GET /api/price/btc before feed → 404", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("GET", "/api/price/btc", null);
    assert.equal(res.status, 404);
  });

  it("GET /api/alerts with no prices → empty", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("GET", "/api/alerts", null);
    assert.equal(res.status, 200);
    var body = JSON.parse(res.body);
    assert(Array.isArray(body), "alerts should be array");
    assert.equal(body.length, 0);
  });
});

describe("Trigger alerts via REST", function() {
  it("price above threshold → sell_alert via GET alerts", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 72000, timestamp: 2000 });
    assert.equal(res.status, 200);
    // Check alerts via GET
    var alerts = JSON.parse(s.handler.handleRequest("GET", "/api/alerts", null).body);
    assert(Array.isArray(alerts), "alerts should be array");
    assert(alerts.length >= 1, "should have sell alert");
  });

  it("price below threshold → buy_alert via GET alerts", function() {
    var s = buildServer();
    s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 55000, timestamp: 2000 });
    var alerts = JSON.parse(s.handler.handleRequest("GET", "/api/alerts", null).body);
    assert(alerts.length >= 1, "should have buy alert");
  });

  it("price in range → no alerts", function() {
    var s = buildServer();
    s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 65000, timestamp: 2000 });
    var alerts = JSON.parse(s.handler.handleRequest("GET", "/api/alerts", null).body);
    assert.equal(alerts.length, 0, "no alerts in range");
  });

  it("GET /api/alerts/btc returns alerts for btc only", function() {
    var s = buildServer();
    s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 72000, timestamp: 2000 });
    s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "eth", price: 3500, timestamp: 2001 });
    var btcAlerts = JSON.parse(s.handler.handleRequest("GET", "/api/alerts/btc", null).body);
    assert(btcAlerts.length >= 1, "btc alert");
    var ethAlerts = JSON.parse(s.handler.handleRequest("GET", "/api/alerts/eth", null).body);
    assert.equal(ethAlerts.length, 0, "eth in range, no alerts");
  });
});

describe("String body parsing", function() {
  it("handles JSON string body", function() {
    var s = buildServer();
    var res = s.handler.handleRequest("POST", "/api/price",
      '{"feed":"coinbase","symbol":"btc","price":67000,"timestamp":1000}');
    assert.equal(res.status, 200);
  });
});

describe("Fossil hash", function() {
  it("returns consistent hash for same DB", function() {
    var s1 = buildServer();
    var s2 = buildServer();
    var h1 = s1.handler.fossilHash();
    var h2 = s2.handler.fossilHash();
    assert.equal(h1, h2, "same rules → same hash");
  });

  it("accepts hash function", function() {
    var s = buildServer();
    var h = s.handler.fossilHash(function(text) {
      return "hashed:" + text.length;
    });
    assert(h.indexOf("hashed:") === 0, "custom hash function applied");
  });
});

describe("Fossilize + mineralize integration", function() {
  it("fossilized server rejects handle/4 injection", function() {
    var s = buildServer();
    mineralize(s.engine, "handle", 4);
    fossilize(s.engine);
    // Try to add a backdoor route
    s.engine.queryFirst(
      PrologEngine.compound("assert", [
        PrologEngine.compound("handle", [
          PrologEngine.atom("get"), PrologEngine.atom("/backdoor"),
          PrologEngine.variable("_"), PrologEngine.compound("response",
            [PrologEngine.num(200), PrologEngine.atom("hacked")])])])
    );
    var res = s.handler.handleRequest("GET", "/backdoor", null);
    assert.equal(res.status, 404, "backdoor should not exist");
  });

  it("fossilized server still handles normal requests", function() {
    var s = buildServer();
    fossilize(s.engine);
    var res = s.handler.handleRequest("GET", "/api/health", null);
    assert.equal(res.status, 200);
  });

  it("data flows through fossilized rules", function() {
    var s = buildServer();
    // Feed price BEFORE fossilize (data mutation still works)
    s.handler.handleRequest("POST", "/api/price",
      { feed: "coinbase", symbol: "btc", price: 72000, timestamp: 2000 });
    // Fossilize
    fossilize(s.engine);
    // Query still works (rules are fossils, data is in ephemeral zone)
    // Note: after fossilize, new prices can't be fed (assert blocked)
    // But existing data can be queried
    var res = s.handler.handleRequest("GET", "/api/alerts", null);
    assert.equal(res.status, 200);
  });
});

// ── Run ─────────────────────────────────────────────────────

runTests();
