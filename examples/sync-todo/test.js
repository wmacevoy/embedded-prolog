// ============================================================
// test.js — Tests for sync module + todo KB
//
// Run:  node examples/sync-todo/test.js
//       bun run examples/sync-todo/test.js
// ============================================================

import { PrologEngine, termToString } from "../../src/prolog-engine.js";
import { serialize, deserialize, termEq, SyncEngine } from "../../src/sync.js";
import { buildTodoKB } from "./todo-kb.js";

const { atom, variable, compound, num, list } = PrologEngine;

// ── Test framework ──────────────────────────────────────────

let _suite = "", _pass = 0, _fail = 0;
function describe(name, fn) { _suite = name; fn(); }
function it(name, fn) {
  try { fn(); _pass++; console.log(`    \u2713 ${name}`); }
  catch(e) { _fail++; console.log(`    \u2717 ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { assert(a === b, msg || `expected ${b}, got ${a}`); }

// ── Serialization ───────────────────────────────────────────

describe("Serialization", () => {
  it("round-trips atom", () => {
    const t = atom("hello");
    const s = serialize(t);
    eq(s.t, "a"); eq(s.n, "hello");
    const d = deserialize(s);
    eq(d.type, "atom"); eq(d.name, "hello");
  });

  it("round-trips num", () => {
    const t = num(42);
    const s = serialize(t);
    eq(s.t, "n"); eq(s.v, 42);
    const d = deserialize(s);
    eq(d.type, "num"); eq(d.value, 42);
  });

  it("round-trips variable", () => {
    const t = variable("X");
    const s = serialize(t);
    eq(s.t, "v"); eq(s.n, "X");
    const d = deserialize(s);
    eq(d.type, "var"); eq(d.name, "X");
  });

  it("round-trips compound", () => {
    const t = compound("todo", [atom("1"), atom("Buy milk"), atom("active"), atom("Alice")]);
    const s = serialize(t);
    eq(s.t, "c"); eq(s.f, "todo"); eq(s.a.length, 4);
    eq(s.a[0].n, "1"); eq(s.a[1].n, "Buy milk");
    const d = deserialize(s);
    eq(d.type, "compound"); eq(d.functor, "todo");
    eq(d.args[1].name, "Buy milk");
  });

  it("round-trips list", () => {
    const t = list([atom("a"), atom("b"), atom("c")]);
    const s = serialize(t);
    const d = deserialize(s);
    eq(d.type, "compound"); eq(d.functor, ".");
    eq(d.args[0].name, "a");
  });

  it("survives JSON.stringify/parse", () => {
    const t = compound("f", [atom("x"), num(3), compound("g", [variable("Y")])]);
    const json = JSON.stringify(serialize(t));
    const d = deserialize(JSON.parse(json));
    eq(d.functor, "f"); eq(d.args[1].value, 3);
    eq(d.args[2].functor, "g"); eq(d.args[2].args[0].name, "Y");
  });

  it("handles null", () => {
    eq(serialize(null), null);
    eq(deserialize(null), null);
  });
});

// ── Term equality ───────────────────────────────────────────

describe("Term equality", () => {
  it("atoms match by name", () => {
    assert(termEq(atom("x"), atom("x")));
    assert(!termEq(atom("x"), atom("y")));
  });

  it("nums match by value", () => {
    assert(termEq(num(5), num(5)));
    assert(!termEq(num(5), num(6)));
  });

  it("compounds match recursively", () => {
    const a = compound("f", [atom("x"), num(1)]);
    const b = compound("f", [atom("x"), num(1)]);
    const c = compound("f", [atom("x"), num(2)]);
    assert(termEq(a, b));
    assert(!termEq(a, c));
  });

  it("different types don't match", () => {
    assert(!termEq(atom("5"), num(5)));
    assert(!termEq(atom("x"), variable("x")));
  });

  it("deserialized terms match originals", () => {
    const t = compound("todo", [atom("1"), atom("hi")]);
    const d = deserialize(serialize(t));
    assert(termEq(t, d));
  });
});

// ── SyncEngine ──────────────────────────────────────────────

describe("SyncEngine", () => {
  it("assertFact adds to engine and tracks", () => {
    const e = new PrologEngine();
    const sync = new SyncEngine(e);
    const head = compound("todo", [atom("1"), atom("test"), atom("active"), atom("me")]);
    eq(sync.assertFact(head), true);
    const r = e.queryFirst(compound("todo", [variable("I"), variable("T"), atom("active"), variable("O")]));
    assert(r !== null);
    eq(r.args[1].name, "test");
  });

  it("assertFact deduplicates", () => {
    const e = new PrologEngine();
    const sync = new SyncEngine(e);
    const head = compound("todo", [atom("1"), atom("test"), atom("active"), atom("me")]);
    eq(sync.assertFact(head), true);
    eq(sync.assertFact(head), false);
    eq(e.query(compound("todo", [variable("I"), variable("T"), variable("S"), variable("O")])).length, 1);
  });

  it("retractFact removes from engine and tracking", () => {
    const e = new PrologEngine();
    const sync = new SyncEngine(e);
    const head = compound("todo", [atom("1"), atom("test"), atom("active"), atom("me")]);
    sync.assertFact(head);
    eq(sync.retractFact(head), true);
    eq(e.queryFirst(compound("todo", [variable("I"), variable("T"), variable("S"), variable("O")])), null);
  });

  it("retractFact returns false for unknown fact", () => {
    const e = new PrologEngine();
    const sync = new SyncEngine(e);
    eq(sync.retractFact(atom("nope")), false);
  });

  it("calls onSync on assert and retract", () => {
    const e = new PrologEngine();
    let count = 0;
    const sync = new SyncEngine(e, { onSync: () => count++ });
    sync.assertFact(atom("x"));
    eq(count, 1);
    sync.retractFact(atom("x"));
    eq(count, 2);
  });

  it("getSnapshot returns serialized tracked facts", () => {
    const e = new PrologEngine();
    const sync = new SyncEngine(e);
    sync.assertFact(compound("todo", [atom("1"), atom("a"), atom("active"), atom("me")]));
    sync.assertFact(compound("todo", [atom("2"), atom("b"), atom("done"), atom("you")]));
    const snap = sync.getSnapshot();
    eq(snap.length, 2);
    eq(snap[0].f, "todo");
    eq(snap[1].a[2].n, "done");
  });

  it("applySnapshot replaces all tracked facts", () => {
    const e = new PrologEngine();
    const sync = new SyncEngine(e);
    // Start with one fact
    sync.assertFact(compound("todo", [atom("old"), atom("x"), atom("active"), atom("me")]));
    // Apply snapshot with different facts
    const snap = [
      serialize(compound("todo", [atom("new1"), atom("a"), atom("active"), atom("server")])),
      serialize(compound("todo", [atom("new2"), atom("b"), atom("done"), atom("server")])),
    ];
    sync.applySnapshot(snap);
    // Old fact should be gone
    eq(e.queryFirst(compound("todo", [atom("old"), variable("_"), variable("_"), variable("_")])), null);
    // New facts should be present
    const all = e.query(compound("todo", [variable("I"), variable("T"), variable("S"), variable("O")]));
    eq(all.length, 2);
  });

  it("applySnapshot preserves non-synced clauses (rules)", () => {
    const e = buildTodoKB(PrologEngine);
    const sync = new SyncEngine(e);
    sync.assertFact(compound("todo", [atom("1"), atom("test"), atom("active"), atom("me")]));
    // Apply empty snapshot (clears synced facts)
    sync.applySnapshot([]);
    // Rules should still work
    const count = e.queryFirst(compound("todo_count", [variable("A"), variable("D")]));
    assert(count !== null, "rules should survive snapshot");
    eq(count.args[0].value, 0);
  });
});

// ── Shared KB rules ─────────────────────────────────────────

describe("Todo KB rules", () => {
  it("todo_count returns 0,0 when empty", () => {
    const e = buildTodoKB(PrologEngine);
    const r = e.queryFirst(compound("todo_count", [variable("A"), variable("D")]));
    assert(r !== null);
    eq(r.args[0].value, 0);
    eq(r.args[1].value, 0);
  });

  it("todo_count counts active and done separately", () => {
    const e = buildTodoKB(PrologEngine);
    e.addClause(compound("todo", [atom("1"), atom("a"), atom("active"), atom("me")]));
    e.addClause(compound("todo", [atom("2"), atom("b"), atom("active"), atom("me")]));
    e.addClause(compound("todo", [atom("3"), atom("c"), atom("done"), atom("me")]));
    const r = e.queryFirst(compound("todo_count", [variable("A"), variable("D")]));
    eq(r.args[0].value, 2);
    eq(r.args[1].value, 1);
  });

  it("all_done is true when no active todos", () => {
    const e = buildTodoKB(PrologEngine);
    e.addClause(compound("todo", [atom("1"), atom("a"), atom("done"), atom("me")]));
    assert(e.queryFirst(compound("all_done", [])) !== null);
  });

  it("all_done is false when active todos exist", () => {
    const e = buildTodoKB(PrologEngine);
    e.addClause(compound("todo", [atom("1"), atom("a"), atom("active"), atom("me")]));
    assert(e.queryFirst(compound("all_done", [])) === null);
  });
});

// ── End-to-end: simulated sync ──────────────────────────────

describe("End-to-end sync simulation", () => {
  it("two engines stay in sync via serialized messages", () => {
    // Server
    const serverEngine = buildTodoKB(PrologEngine);
    const serverSync = new SyncEngine(serverEngine);

    // Client
    const clientEngine = buildTodoKB(PrologEngine);
    const clientSync = new SyncEngine(clientEngine);

    // Server seeds a todo
    serverSync.assertFact(compound("todo", [atom("s1"), atom("Server task"), atom("active"), atom("Server")]));

    // Client connects — gets snapshot
    const snapshot = serverSync.getSnapshot();
    clientSync.applySnapshot(snapshot);

    // Client should now have the todo
    const r1 = clientEngine.queryFirst(compound("todo", [atom("s1"), variable("T"), variable("S"), variable("O")]));
    assert(r1 !== null);
    eq(r1.args[1].name, "Server task");

    // Client adds a todo — simulate: client sends, server applies, server broadcasts back
    const clientTodo = compound("todo", [atom("c1"), atom("Client task"), atom("active"), atom("Alice")]);
    const wire = JSON.parse(JSON.stringify(serialize(clientTodo))); // simulate wire

    // Server receives and applies
    serverSync.assertFact(deserialize(wire));

    // Server broadcasts — client receives
    const broadcast = JSON.parse(JSON.stringify(serialize(clientTodo)));
    clientSync.assertFact(deserialize(broadcast));

    // Both engines should have 2 todos
    const serverCount = serverEngine.queryFirst(compound("todo_count", [variable("A"), variable("D")]));
    const clientCount = clientEngine.queryFirst(compound("todo_count", [variable("A"), variable("D")]));
    eq(serverCount.args[0].value, 2);
    eq(clientCount.args[0].value, 2);
  });

  it("complete todo: retract active + assert done", () => {
    const e = buildTodoKB(PrologEngine);
    const sync = new SyncEngine(e);

    const todo = compound("todo", [atom("1"), atom("task"), atom("active"), atom("me")]);
    sync.assertFact(todo);

    // Complete: retract active, assert done
    sync.retractFact(todo);
    const done = compound("todo", [atom("1"), atom("task"), atom("done"), atom("me")]);
    sync.assertFact(done);

    const count = e.queryFirst(compound("todo_count", [variable("A"), variable("D")]));
    eq(count.args[0].value, 0);
    eq(count.args[1].value, 1);
  });
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n  ${_pass} passing, ${_fail} failing`);
if (_fail > 0) process.exit(1);
