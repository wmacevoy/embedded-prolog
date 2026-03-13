// ============================================================
// sync.js — Term serialization + fact synchronization
//
// Portable: same constraints as reactive.js
// Works in: Node 12+, Bun, Deno, QuickJS, Duktape, Hermes,
// all browsers (ES2015+ for Map), V8/JSC/SpiderMonkey shell.
// ============================================================

// ── Term serialization (compact wire format) ────────────────
//
// atom("hello")            → { t: "a", n: "hello" }
// num(42)                  → { t: "n", v: 42 }
// variable("X")            → { t: "v", n: "X" }
// compound("f", [a1, a2])  → { t: "c", f: "f", a: [..] }

function serialize(term) {
  if (!term) return null;
  if (term.type === "atom") return { t: "a", n: term.name };
  if (term.type === "num")  return { t: "n", v: term.value };
  if (term.type === "var")  return { t: "v", n: term.name };
  if (term.type === "compound") {
    var a = [];
    for (var i = 0; i < term.args.length; i++) {
      a.push(serialize(term.args[i]));
    }
    return { t: "c", f: term.functor, a: a };
  }
  return null;
}

function deserialize(obj) {
  if (!obj) return null;
  if (obj.t === "a") return { type: "atom", name: obj.n };
  if (obj.t === "n") return { type: "num", value: obj.v };
  if (obj.t === "v") return { type: "var", name: obj.n };
  if (obj.t === "c") {
    var a = [];
    for (var i = 0; i < obj.a.length; i++) {
      a.push(deserialize(obj.a[i]));
    }
    return { type: "compound", functor: obj.f, args: a };
  }
  return null;
}

// ── Term equality ───────────────────────────────────────────

function termEq(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "atom") return a.name === b.name;
  if (a.type === "num")  return a.value === b.value;
  if (a.type === "var")  return a.name === b.name;
  if (a.type === "compound") {
    if (a.functor !== b.functor) return false;
    if (a.args.length !== b.args.length) return false;
    for (var i = 0; i < a.args.length; i++) {
      if (!termEq(a.args[i], b.args[i])) return false;
    }
    return true;
  }
  return false;
}

// ── Fact synchronization engine ─────────────────────────────
//
// Tracks which facts have been synced, provides assert/retract
// with deduplication, and snapshot/restore for initial sync.
//
// Usage:
//   var sync = new SyncEngine(engine, { onSync: bump });
//   sync.assertFact(head);         // local apply + track
//   sync.retractFact(head);        // local remove + untrack
//   sync.getSnapshot();            // → serialized fact array
//   sync.applySnapshot(facts);     // clear + bulk apply

function SyncEngine(engine, opts) {
  opts = opts || {};
  this.engine = engine;
  this._facts = [];
  this.onSync = opts.onSync || function() {};
  // opts.syncPredicates is an object mapping "functor/arity" to "client" | "server" | "both"
  // Example: { "todo/4": "client", "config/2": "server" }
  // If null/undefined, all facts are allowed (backward compatible)
  this._syncPredicates = opts.syncPredicates || null;
}

SyncEngine.prototype._predicateKey = function(head) {
  if (head.type === "compound") {
    return head.functor + "/" + head.args.length;
  }
  if (head.type === "atom") {
    return head.name + "/0";
  }
  return null;
};

SyncEngine.prototype.isAllowed = function(head, source) {
  if (this._syncPredicates === null) return true;
  var key = this._predicateKey(head);
  if (key === null) return false;
  if (!(key in this._syncPredicates)) return false;
  var val = this._syncPredicates[key];
  if (val === "both") return true;
  if (val === source) return true;
  return false;
};

SyncEngine.prototype.assertFact = function(head, source) {
  if (typeof source !== "undefined" && !this.isAllowed(head, source)) {
    return false;
  }
  for (var i = 0; i < this._facts.length; i++) {
    if (termEq(this._facts[i], head)) return false;
  }
  this.engine.addClause(head);
  this._facts.push(head);
  this.onSync();
  return true;
};

SyncEngine.prototype.retractFact = function(head, source) {
  if (typeof source !== "undefined" && !this.isAllowed(head, source)) {
    return false;
  }
  for (var i = 0; i < this._facts.length; i++) {
    if (termEq(this._facts[i], head)) {
      this._facts.splice(i, 1);
      this.engine.retractFirst(head);
      this.onSync();
      return true;
    }
  }
  return false;
};

SyncEngine.prototype.getSnapshot = function() {
  var result = [];
  for (var i = 0; i < this._facts.length; i++) {
    result.push(serialize(this._facts[i]));
  }
  return result;
};

SyncEngine.prototype.applySnapshot = function(facts) {
  var i;
  for (i = 0; i < this._facts.length; i++) {
    this.engine.retractFirst(this._facts[i]);
  }
  this._facts = [];
  for (i = 0; i < facts.length; i++) {
    var head = deserialize(facts[i]);
    this.engine.addClause(head);
    this._facts.push(head);
  }
  this.onSync();
};

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.serialize = serialize;
  exports.deserialize = deserialize;
  exports.termEq = termEq;
  exports.SyncEngine = SyncEngine;
}
export { serialize, deserialize, termEq, SyncEngine };
