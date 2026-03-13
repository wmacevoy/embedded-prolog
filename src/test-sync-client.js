// ============================================================
// test-sync-client.js — Tests for sync-client.js
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
//
// Run with ANY JavaScript runtime:
//   node src/test-sync-client.js
//   deno run src/test-sync-client.js
//   bun run src/test-sync-client.js
// ============================================================

// ── print() polyfill ────────────────────────────────────────
var _print = (typeof print !== "undefined" && typeof window === "undefined" && typeof Deno === "undefined") ? print : console.log.bind(console);

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
        _print("    PASS " + test.name);
      } catch (e) {
        suite.fail++; totalFail++;
        _print("    FAIL " + test.name);
        _print("      " + (e.message || e));
      }
    }
  }
  _print("\n  " + totalPass + " passing, " + totalFail + " failing\n");
  if (totalFail > 0 && typeof process !== "undefined" && process.exit) process.exit(1);
  return totalFail;
}

// ── Imports ─────────────────────────────────────────────────

import { PrologEngine } from "./prolog-engine.js";
import { SyncEngine, serialize, termEq } from "./sync.js";
import { SyncClient } from "./sync-client.js";

var at = PrologEngine.atom;
var c = PrologEngine.compound;
var n = PrologEngine.num;

// ── Helpers ─────────────────────────────────────────────────

function makeSyncEngine() {
  var engine = new PrologEngine();
  return new SyncEngine(engine);
}

function makeSentLog() {
  return [];
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe("Queue accumulates when disconnected", function() {
  it("queues assertFact when isConnected returns false", function() {
    var sync = makeSyncEngine();
    var sent = makeSentLog();
    var client = new SyncClient(sync, {
      send: function(msg) { sent.push(msg); },
      isConnected: function() { return false; }
    });

    client.assertFact(c("todo", [at("buy_milk")]));
    client.assertFact(c("todo", [at("do_laundry")]));

    assert.equal(client.queueLength(), 2, "queue should have 2 items");
    assert.equal(sent.length, 0, "nothing should have been sent");
    // Fact should NOT be applied locally while disconnected
    assert.equal(sync._facts.length, 0, "no facts applied locally");
  });

  it("queues retractFact when isConnected returns false", function() {
    var sync = makeSyncEngine();
    var sent = makeSentLog();
    var client = new SyncClient(sync, {
      send: function(msg) { sent.push(msg); },
      isConnected: function() { return false; }
    });

    client.retractFact(c("todo", [at("buy_milk")]));

    assert.equal(client.queueLength(), 1, "queue should have 1 item");
    assert.equal(sent.length, 0, "nothing should have been sent");
  });
});

describe("assertFact sends immediately when connected", function() {
  it("sends assert message and applies locally", function() {
    var sync = makeSyncEngine();
    var sent = makeSentLog();
    var client = new SyncClient(sync, {
      send: function(msg) { sent.push(msg); },
      isConnected: function() { return true; }
    });

    var head = c("todo", [at("buy_milk")]);
    client.assertFact(head);

    assert.equal(sent.length, 1, "one message sent");
    assert.equal(sent[0].kind, "assert");
    assert.deepEqual(sent[0].head, serialize(head));
    assert.equal(client.queueLength(), 0, "queue should be empty");
    assert.equal(sync._facts.length, 1, "fact applied locally");
  });

  it("sends retract message immediately when connected", function() {
    var sync = makeSyncEngine();
    var sent = makeSentLog();
    var client = new SyncClient(sync, {
      send: function(msg) { sent.push(msg); },
      isConnected: function() { return true; }
    });

    // First assert a fact so we can retract it
    var head = c("todo", [at("buy_milk")]);
    client.assertFact(head);
    client.retractFact(head);

    assert.equal(sent.length, 2, "two messages sent");
    assert.equal(sent[1].kind, "retract");
    assert.equal(sync._facts.length, 0, "fact retracted locally");
  });
});

describe("handleMessage snapshot applies snapshot then flushes queue", function() {
  it("applies snapshot and replays queued operations", function() {
    var sync = makeSyncEngine();
    var sent = makeSentLog();
    var connected = false;
    var client = new SyncClient(sync, {
      send: function(msg) { sent.push(msg); },
      isConnected: function() { return connected; }
    });

    // Queue operations while disconnected
    client.assertFact(c("todo", [at("buy_milk")]));
    client.assertFact(c("todo", [at("do_laundry")]));
    assert.equal(client.queueLength(), 2);

    // Simulate reconnect: server sends snapshot with existing facts
    connected = true;
    var snapshotFacts = [
      serialize(c("todo", [at("existing_task")]))
    ];
    client.handleMessage({ kind: "snapshot", facts: snapshotFacts });

    // Snapshot should be applied
    // Queue should be flushed (replayed)
    assert.equal(client.queueLength(), 0, "queue should be empty after flush");
    assert.equal(sent.length, 2, "queued ops sent to server");
    // Local state: existing_task from snapshot + buy_milk + do_laundry from queue
    assert.equal(sync._facts.length, 3, "should have 3 facts total");
  });
});

describe("handleMessage assert applies fact locally", function() {
  it("applies server-sent assert fact", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return true; }
    });

    var head = c("config", [at("debug"), at("true")]);
    client.handleMessage({ kind: "assert", head: serialize(head) });

    assert.equal(sync._facts.length, 1, "fact should be applied");
    assert.ok(termEq(sync._facts[0], head), "applied fact should match");
  });

  it("applies server-sent retract", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return true; }
    });

    var head = c("config", [at("debug"), at("true")]);
    // First add a fact
    sync.assertFact(head);
    assert.equal(sync._facts.length, 1);

    // Server sends retract
    client.handleMessage({ kind: "retract", head: serialize(head) });
    assert.equal(sync._facts.length, 0, "fact should be retracted");
  });
});

describe("compact removes assert+retract pairs", function() {
  it("cancels an assert followed by a retract of the same term", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });

    var head = c("todo", [at("buy_milk")]);
    client.assertFact(head);
    client.retractFact(head);
    assert.equal(client.queueLength(), 2);

    client.compact();
    assert.equal(client.queueLength(), 0, "assert+retract should cancel out");
  });

  it("preserves unmatched operations after compaction", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });

    client.assertFact(c("todo", [at("a")]));
    client.assertFact(c("todo", [at("b")]));
    client.retractFact(c("todo", [at("a")]));

    assert.equal(client.queueLength(), 3);
    client.compact();
    // assert(a) + retract(a) cancel; assert(b) remains
    assert.equal(client.queueLength(), 1, "only assert(b) should remain");
  });

  it("handles multiple cancellations", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });

    client.assertFact(c("x", [at("1")]));
    client.assertFact(c("x", [at("2")]));
    client.retractFact(c("x", [at("1")]));
    client.retractFact(c("x", [at("2")]));

    client.compact();
    assert.equal(client.queueLength(), 0, "all pairs should cancel");
  });
});

describe("compact deduplicates same asserts", function() {
  it("removes consecutive duplicate asserts", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });

    var head = c("todo", [at("buy_milk")]);
    client.assertFact(head);
    client.assertFact(head);
    client.assertFact(head);

    assert.equal(client.queueLength(), 3);
    client.compact();
    assert.equal(client.queueLength(), 1, "consecutive duplicates should be removed");
  });

  it("keeps non-consecutive same asserts", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });

    var head = c("todo", [at("buy_milk")]);
    client.assertFact(head);
    client.assertFact(c("todo", [at("other")]));
    client.assertFact(head);

    client.compact();
    // Non-consecutive, so both asserts of head remain
    assert.equal(client.queueLength(), 3, "non-consecutive asserts should remain");
  });
});

describe("queueLength returns correct count", function() {
  it("returns 0 for empty queue", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });
    assert.equal(client.queueLength(), 0);
  });

  it("returns correct count after operations", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return false; }
    });

    client.assertFact(c("a", [at("1")]));
    assert.equal(client.queueLength(), 1);
    client.assertFact(c("a", [at("2")]));
    assert.equal(client.queueLength(), 2);
    client.retractFact(c("a", [at("1")]));
    assert.equal(client.queueLength(), 3);
  });

  it("returns 0 after flush", function() {
    var sync = makeSyncEngine();
    var client = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return true; }
    });

    // Queue some ops while disconnected
    var connected = false;
    var client2 = new SyncClient(sync, {
      send: function() {},
      isConnected: function() { return connected; }
    });
    client2.assertFact(c("a", [at("1")]));
    client2.assertFact(c("a", [at("2")]));
    assert.equal(client2.queueLength(), 2);

    connected = true;
    client2.flush();
    assert.equal(client2.queueLength(), 0, "queue should be empty after flush");
  });
});

describe("Full round-trip: disconnect, queue, reconnect with snapshot", function() {
  it("produces correct final state", function() {
    var engine = new PrologEngine();
    var sync = new SyncEngine(engine);
    var sent = makeSentLog();
    var connected = false;

    var client = new SyncClient(sync, {
      send: function(msg) { sent.push(msg); },
      isConnected: function() { return connected; }
    });

    // Phase 1: connected, add initial facts
    connected = true;
    client.assertFact(c("item", [at("a")]));
    client.assertFact(c("item", [at("b")]));
    assert.equal(sync._facts.length, 2, "2 facts after initial adds");
    assert.equal(sent.length, 2, "2 messages sent");

    // Phase 2: disconnect, queue operations
    connected = false;
    client.assertFact(c("item", [at("c")]));
    client.retractFact(c("item", [at("a")]));
    assert.equal(client.queueLength(), 2, "2 ops queued");
    assert.equal(sync._facts.length, 2, "local state unchanged while disconnected");
    assert.equal(sent.length, 2, "no new messages sent while disconnected");

    // Phase 3: reconnect with snapshot from server
    // Server has: item(a), item(b), item(d) (server added d while we were offline)
    connected = true;
    var serverSnapshot = [
      serialize(c("item", [at("a")])),
      serialize(c("item", [at("b")])),
      serialize(c("item", [at("d")]))
    ];
    client.handleMessage({ kind: "snapshot", facts: serverSnapshot });

    // After snapshot + flush:
    //   snapshot sets state to: a, b, d
    //   queue replays: assert(c) -> a, b, d, c
    //                  retract(a) -> b, d, c
    assert.equal(client.queueLength(), 0, "queue empty after reconnect");
    assert.equal(sync._facts.length, 3, "final state should have 3 facts");

    // Verify the exact facts: b, d, c (a was retracted)
    var hasB = false, hasC = false, hasD = false, hasA = false;
    for (var i = 0; i < sync._facts.length; i++) {
      var f = sync._facts[i];
      if (f.type === "compound" && f.functor === "item") {
        if (f.args[0].name === "a") hasA = true;
        if (f.args[0].name === "b") hasB = true;
        if (f.args[0].name === "c") hasC = true;
        if (f.args[0].name === "d") hasD = true;
      }
    }
    assert.ok(!hasA, "item(a) should have been retracted");
    assert.ok(hasB, "item(b) should be present");
    assert.ok(hasC, "item(c) should be present from queue replay");
    assert.ok(hasD, "item(d) should be present from server snapshot");

    // Verify the queued ops were sent to server
    assert.equal(sent.length, 4, "4 total messages: 2 initial + 2 replayed");
    assert.equal(sent[2].kind, "assert", "replayed assert");
    assert.equal(sent[3].kind, "retract", "replayed retract");

    // Verify engine can query the facts
    var results = engine.query(c("item", [PrologEngine.variable("X")]));
    assert.equal(results.length, 3, "engine query should find 3 items");
  });
});

// ── Run ─────────────────────────────────────────────────────

var failures = runTests();
