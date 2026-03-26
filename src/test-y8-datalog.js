// ============================================================
// test-y8-datalog.js — Tests for Y8 Datalog layer (JS)
//
// Requires: better-sqlite3 or bun:sqlite
// Run: node src/test-y8-datalog.js
// ============================================================

import { y8Datalog } from './y8-datalog.js';
import { y8LoadProgram } from './y8-loader.js';

var Database;
try {
  Database = require("better-sqlite3");
} catch(e) {
  try {
    Database = require("bun:sqlite").Database;
  } catch(e2) {
    console.log("  (skipping JS datalog tests — no SQLite driver)");
    process.exit(0);
  }
}

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  \u2713 " + name); }
  catch(e) { failed++; console.log("  \u2717 " + name + ": " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { assert(a === b, msg || "expected " + b + ", got " + a); }

function freshDb() {
  var sqlite = new Database(":memory:");
  var db = y8Datalog(sqlite);
  db.setup();
  return db;
}

// ── Facts ──────────────────────────────────────────────────

console.log("y8-datalog.js");

test("assert and query", function() {
  var db = freshDb();
  db.assertFact("parent", ["alice", "bob"]);
  db.assertFact("parent", ["bob", "carol"]);
  var results = db.query("parent");
  eq(results.length, 2);
});

test("assert idempotent", function() {
  var db = freshDb();
  db.assertFact("parent", ["alice", "bob"]);
  db.assertFact("parent", ["alice", "bob"]);
  eq(db.query("parent").length, 1);
});

test("query with pattern", function() {
  var db = freshDb();
  db.assertFact("parent", ["alice", "bob"]);
  db.assertFact("parent", ["bob", "carol"]);
  var results = db.query("parent", [null, "bob"]);
  eq(results.length, 1);
  eq(results[0][0], "alice");
});

test("retract", function() {
  var db = freshDb();
  db.assertFact("parent", ["alice", "bob"]);
  db.assertFact("parent", ["bob", "carol"]);
  assert(db.retract("parent", ["alice", "bob"]));
  eq(db.query("parent").length, 1);
});

test("retract all", function() {
  var db = freshDb();
  db.assertFact("parent", ["alice", "bob"]);
  db.assertFact("parent", ["carol", "bob"]);
  db.assertFact("parent", ["eve", "frank"]);
  eq(db.retractAll("parent", [null, "bob"]), 2);
  eq(db.query("parent").length, 1);
});

// ── Callbacks ──────────────────────────────────────────────

test("on_assert callback", function() {
  var db = freshDb();
  var events = [];
  db.onAssert.push(function(pred, fact) { events.push([pred, fact]); });
  db.assertFact("parent", ["alice", "bob"]);
  eq(events.length, 1);
  eq(events[0][0], "parent");
});

// ── React ──────────────────────────────────────────────────

test("react on assert", function() {
  var db = freshDb();
  var events = [];
  db.addReact("assert", function(et, pred, fact) { events.push(fact); });
  db.assertFact("parent", ["alice", "bob"]);
  eq(events.length, 1);
});

test("react cascading", function() {
  var db = freshDb();
  db.addReact("assert", function(et, pred, fact, db) {
    if (pred === "parent") db.assertFact("has_child", [fact[0]]);
  });
  db.assertFact("parent", ["alice", "bob"]);
  eq(db.query("has_child").length, 1);
  eq(db.query("has_child")[0][0], "alice");
});

// ── Ephemeral ──────────────────────────────────────────────

test("ephemeral", function() {
  var db = freshDb();
  var events = [];
  db.addReact("signal", function(et, pred, fact) { events.push(fact); });
  db.ephemeral("signal", "temperature", ["sensor1", 35]);
  eq(events.length, 1);
  eq(db.query("temperature").length, 0);
});

// ── Native / Send ──────────────────────────────────────────

test("native", function() {
  var db = freshDb();
  db.registerNative("double", function(args) { return args[0] * 2; });
  eq(db.callNative("double", [21]), 42);
});

test("send", function() {
  var db = freshDb();
  db.send("alerts", { type: "overheat" });
  var sends = db.collectSends();
  eq(sends.length, 1);
  eq(sends[0].target, "alerts");
  eq(db.collectSends().length, 0);
});

// ── Resolve ────────────────────────────────────────────────

test("resolve facts", function() {
  var db = freshDb();
  db.assertFact("parent", ["alice", "bob"]);
  db.assertFact("parent", ["bob", "carol"]);
  var results = db.resolve("parent", [{ $qjson: "unbound", name: "X" }, "bob"]);
  eq(results.length, 1);
  eq(results[0].X, "alice");
});

// ── Loader ─────────────────────────────────────────────────

test("load facts", function() {
  var db = freshDb();
  var count = y8LoadProgram(db, "parent(alice, bob). parent(bob, carol).");
  eq(count, 2);
  eq(db.query("parent").length, 2);
});

test("load numbers", function() {
  var db = freshDb();
  y8LoadProgram(db, "price(btc, 67432). price(eth, 3500).");
  eq(db.query("price").length, 2);
});

// ── Summary ────────────────────────────────────────────────

console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
