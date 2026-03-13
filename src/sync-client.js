// ============================================================
// sync-client.js — Offline-capable sync client
//
// Queues operations while disconnected, replays on reconnect.
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
// Works in: Node 12+, Bun, Deno, QuickJS, Duktape, Hermes,
// all browsers (ES2015+ for Map), V8/JSC/SpiderMonkey shell.
// ============================================================

import { serialize, deserialize, termEq } from "./sync.js";

// ── SyncClient constructor ──────────────────────────────────
//
// Usage:
//   var client = new SyncClient(syncEngine, {
//     send: function(msg) { ws.send(JSON.stringify(msg)); },
//     isConnected: function() { return ws.readyState === 1; }
//   });

function SyncClient(syncEngine, opts) {
  opts = opts || {};
  this.sync = syncEngine;
  this._send = opts.send || function() {};
  this._isConnected = opts.isConnected || function() { return false; };
  this._queue = [];
}

// ── assertFact ──────────────────────────────────────────────
// If connected: send immediately. If disconnected: push to queue.

SyncClient.prototype.assertFact = function(head) {
  if (this._isConnected()) {
    this._send({ kind: "assert", head: serialize(head) });
    this.sync.assertFact(head);
  } else {
    this._queue.push({ kind: "assert", head: head });
  }
};

// ── retractFact ─────────────────────────────────────────────

SyncClient.prototype.retractFact = function(head) {
  if (this._isConnected()) {
    this._send({ kind: "retract", head: serialize(head) });
    this.sync.retractFact(head);
  } else {
    this._queue.push({ kind: "retract", head: head });
  }
};

// ── handleMessage ───────────────────────────────────────────
// Process inbound messages from server.

SyncClient.prototype.handleMessage = function(msg) {
  if (msg.kind === "snapshot") {
    this.sync.applySnapshot(msg.facts);
    this.flush();
  } else if (msg.kind === "assert") {
    this.sync.assertFact(deserialize(msg.head));
  } else if (msg.kind === "retract") {
    this.sync.retractFact(deserialize(msg.head));
  }
};

// ── flush ───────────────────────────────────────────────────
// Replay all queued operations: send to server AND apply locally.

SyncClient.prototype.flush = function() {
  var ops = this._queue;
  this._queue = [];
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    this._send({ kind: op.kind, head: serialize(op.head) });
    if (op.kind === "assert") {
      this.sync.assertFact(op.head);
    } else if (op.kind === "retract") {
      this.sync.retractFact(op.head);
    }
  }
};

// ── queueLength ─────────────────────────────────────────────

SyncClient.prototype.queueLength = function() {
  return this._queue.length;
};

// ── compact ─────────────────────────────────────────────────
// Optimize queue before replay:
//  1. Remove assert+retract pairs for the same term (they cancel out).
//  2. Deduplicate consecutive asserts of the same term.

SyncClient.prototype.compact = function() {
  var q = this._queue;
  var result = [];
  var i, j, found;

  // Pass 1: cancel matching assert/retract pairs.
  // Walk through; for each retract, find the latest unmatched assert
  // for the same term and remove both.
  var live = [];
  for (i = 0; i < q.length; i++) {
    live.push({ kind: q[i].kind, head: q[i].head, cancelled: false });
  }

  for (i = 0; i < live.length; i++) {
    if (live[i].kind === "retract" && !live[i].cancelled) {
      // Scan backwards for the latest unmatched assert of the same term
      found = false;
      for (j = i - 1; j >= 0; j--) {
        if (!live[j].cancelled && live[j].kind === "assert" && termEq(live[j].head, live[i].head)) {
          live[j].cancelled = true;
          live[i].cancelled = true;
          found = true;
          break;
        }
      }
    }
  }

  // Collect non-cancelled entries
  for (i = 0; i < live.length; i++) {
    if (!live[i].cancelled) {
      result.push({ kind: live[i].kind, head: live[i].head });
    }
  }

  // Pass 2: deduplicate consecutive asserts of the same term.
  var deduped = [];
  for (i = 0; i < result.length; i++) {
    if (result[i].kind === "assert" && i > 0 &&
        result[i - 1].kind === "assert" &&
        termEq(result[i].head, result[i - 1].head)) {
      continue; // skip duplicate
    }
    deduped.push(result[i]);
  }

  this._queue = deduped;
};

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.SyncClient = SyncClient;
}
export { SyncClient };
