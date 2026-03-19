// ============================================================
// test.js — Tests for NNG sensor mesh example
//
// Run:  node examples/nng-mesh/test.js
//       bun run examples/nng-mesh/test.js
// ============================================================

import { PrologEngine, termToString, listToArray } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { serialize, deserialize, termEq, SyncEngine } from "../../src/sync.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { createSignal, createMemo, createEffect } from "../../src/reactive.js";
import { SimBus } from "./transport.js";
import { buildMeshKB } from "./mesh-kb.js";
import { MeshNode } from "./node.js";

const { atom, variable, compound, num } = PrologEngine;

// ── Test framework ──────────────────────────────────────────

let _suite = "", _pass = 0, _fail = 0;
function describe(name, fn) { _suite = name; console.log(`\n  ${name}`); fn(); }
function it(name, fn) {
  try { fn(); _pass++; console.log(`    \u2713 ${name}`); }
  catch(e) { _fail++; console.log(`    \u2717 ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { assert(a === b, msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── Helper: create a wired mesh ─────────────────────────────

function createMesh(nodeIds) {
  const bus = new SimBus();
  const nodes = {};
  for (const id of nodeIds) {
    const transport = bus.createTransport(id);
    nodes[id] = new MeshNode({ id, transport });
  }
  return { bus, nodes };
}

// ── Helper: build a reactive engine for policy tests ────────

function buildReactiveKB(nodeId) {
  const engine = buildMeshKB(PrologEngine, nodeId);
  // Save the engine's built-in ephemeral/1 (fires _fireReact → react rules)
  const nativeEphemeral = engine.builtins["ephemeral/1"];
  createReactiveEngine(engine); // registers auto-bump
  // Restore native ephemeral — reactive layer overrides with old pattern
  engine.builtins["ephemeral/1"] = nativeEphemeral;
  return engine;
}

// ── Helper: build an ephemeral signal QJSON object ──────────

function signalObject(fromAddress, fact) {
  return compound("ephemeral", [
    PrologEngine.object([
      { key: "type", value: atom("signal") },
      { key: "from", value: atom(fromAddress) },
      { key: "fact", value: fact }
    ])
  ]);
}

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

// ── Transport simulation ────────────────────────────────────

describe("SimBus transport", () => {
  it("delivers messages between nodes", () => {
    const bus = new SimBus();
    const t1 = bus.createTransport("a");
    const t2 = bus.createTransport("b");
    let received = null;
    t2.onReceive((from, payload) => { received = { from, payload }; });
    t1.send("b", { data: 42 });
    assert(received !== null, "should have received");
    eq(received.from, "a");
    eq(received.payload.data, 42);
  });

  it("deep-copies payload (no shared references)", () => {
    const bus = new SimBus();
    const t1 = bus.createTransport("a");
    const t2 = bus.createTransport("b");
    let received = null;
    t2.onReceive((from, payload) => { received = payload; });
    const original = { nested: { val: 1 } };
    t1.send("b", original);
    original.nested.val = 999;
    eq(received.nested.val, 1, "should be independent copy");
  });

  it("silently drops messages to non-existent addresses", () => {
    const bus = new SimBus();
    const t1 = bus.createTransport("a");
    t1.send("nobody", { data: 1 }); // should not throw
    eq(bus._log.length, 1);
  });

  it("broadcast reaches all except sender", () => {
    const bus = new SimBus();
    const t1 = bus.createTransport("a");
    const t2 = bus.createTransport("b");
    const t3 = bus.createTransport("c");
    const got = [];
    t1.onReceive((from) => { got.push("a-" + from); });
    t2.onReceive((from) => { got.push("b-" + from); });
    t3.onReceive((from) => { got.push("c-" + from); });
    t1.broadcast({ msg: "hello" });
    eq(got.length, 2);
    assert(got.includes("b-a"));
    assert(got.includes("c-a"));
  });

  it("close removes node from bus", () => {
    const bus = new SimBus();
    const t1 = bus.createTransport("a");
    const t2 = bus.createTransport("b");
    let count = 0;
    t2.onReceive(() => { count++; });
    t1.send("b", { x: 1 });
    eq(count, 1);
    t2.close();
    t1.send("b", { x: 2 });
    eq(count, 1, "should not receive after close");
  });
});

// ── Mesh KB rules ───────────────────────────────────────────

describe("Mesh KB rules", () => {
  it("has default thresholds", () => {
    const e = buildMeshKB(PrologEngine, "test");
    const r = e.queryFirst(compound("threshold", [atom("temperature"), variable("Min"), variable("Max")]));
    assert(r !== null);
    eq(r.args[1].value, 0);
    eq(r.args[2].value, 45);
  });

  it("detects high temperature alert", () => {
    const e = buildMeshKB(PrologEngine, "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(50), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("temperature"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "high");
  });

  it("detects low temperature alert", () => {
    const e = buildMeshKB(PrologEngine, "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(-5), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("temperature"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "low");
  });

  it("no alerts when reading within range", () => {
    const e = buildMeshKB(PrologEngine, "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]));
    const r = e.queryFirst(compound("alert", [variable("N"), variable("T"), variable("L")]));
    eq(r, null);
  });

  it("mesh_status is normal with no readings", () => {
    const e = buildMeshKB(PrologEngine, "coordinator");
    const r = e.queryFirst(compound("mesh_status", [variable("S")]));
    assert(r !== null);
    eq(r.args[0].name, "normal");
  });

  it("mesh_status is critical with alert", () => {
    const e = buildMeshKB(PrologEngine, "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("temperature"), num(99), num(1000)]));
    const r = e.queryFirst(compound("mesh_status", [variable("S")]));
    assert(r !== null);
    eq(r.args[0].name, "critical");
  });

  it("humidity alert detection", () => {
    const e = buildMeshKB(PrologEngine, "coordinator");
    e.addClause(compound("reading", [atom("s1"), atom("humidity"), num(95), num(1000)]));
    const r = e.queryFirst(compound("alert", [atom("s1"), atom("humidity"), variable("L")]));
    assert(r !== null);
    eq(r.args[2].name, "high");
  });
});

// ── Signal policy (via ephemeral + react/1) ─────────────────

describe("Signal policy", () => {
  it("coordinator accepts reading from online sensor", () => {
    const e = buildReactiveKB("coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    e.queryFirst(signalObject("s1", fact));
    // Verify the reading was upserted
    const reading = e.queryFirst(compound("reading", [atom("s1"), atom("temperature"), variable("V"), variable("T")]));
    assert(reading !== null, "reading should have been asserted by react rule");
    eq(reading.args[2].value, 22);
  });

  it("coordinator rejects reading from unknown sensor", () => {
    const e = buildReactiveKB("coordinator");
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    e.queryFirst(signalObject("s1", fact));
    // No react rule matched → reading should NOT be in DB
    const reading = e.queryFirst(compound("reading", [atom("s1"), atom("temperature"), variable("V"), variable("T")]));
    eq(reading, null, "no react match → signal dropped");
  });

  it("coordinator rejects reading where From doesn't match node in fact", () => {
    const e = buildReactiveKB("coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    // Spoofed: signal from "s2" but fact says "s1"
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    e.queryFirst(signalObject("s2", fact));
    const reading = e.queryFirst(compound("reading", [atom("s1"), atom("temperature"), variable("V"), variable("T")]));
    eq(reading, null, "From must match reading node");
  });

  it("coordinator accepts node_status from any node", () => {
    const e = buildReactiveKB("coordinator");
    const fact = compound("node_status", [atom("new_sensor"), atom("online")]);
    e.queryFirst(signalObject("new_sensor", fact));
    // Verify upserted
    const status = e.queryFirst(compound("node_status", [atom("new_sensor"), variable("S")]));
    assert(status !== null, "should accept node_status");
    eq(status.args[1].name, "online");
  });

  it("sensor node accepts threshold from coordinator", () => {
    const e = buildReactiveKB("sensor_1");
    const fact = compound("threshold", [atom("temperature"), num(5), num(40)]);
    e.queryFirst(signalObject("coordinator", fact));
    // Verify upserted (replaces default)
    const th = e.queryFirst(compound("threshold", [atom("temperature"), variable("Min"), variable("Max")]));
    eq(th.args[1].value, 5);
    eq(th.args[2].value, 40);
  });

  it("sensor node ignores reading signals", () => {
    const e = buildReactiveKB("sensor_1");
    const fact = compound("reading", [atom("s2"), atom("temperature"), num(22), num(1000)]);
    e.queryFirst(signalObject("s2", fact));
    const reading = e.queryFirst(compound("reading", [atom("s2"), atom("temperature"), variable("V"), variable("T")]));
    eq(reading, null, "sensor nodes don't accept readings");
  });
});

// ── MeshNode integration ────────────────────────────────────

describe("MeshNode integration", () => {
  it("sensor sends reading, coordinator accepts it", () => {
    const { nodes } = createMesh(["coordinator", "sensor_1"]);
    const coord = nodes.coordinator;
    const sensor = nodes.sensor_1;

    // Register sensor as online on coordinator
    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));
    coord.reactive.bump();

    // Sensor sends reading
    sensor.send("coordinator", compound("reading", [atom("sensor_1"), atom("temperature"), num(23), num(1000)]));

    // Coordinator should have the reading
    const r = coord.queryFirst(compound("reading", [atom("sensor_1"), atom("temperature"), variable("V"), variable("T")]));
    assert(r !== null, "coordinator should have the reading");
    eq(r.args[2].value, 23);
  });

  it("coordinator rejects reading from unknown sensor", () => {
    const { nodes } = createMesh(["coordinator", "rogue"]);
    const coord = nodes.coordinator;
    const rogue = nodes.rogue;

    // rogue is NOT registered as online
    rogue.send("coordinator", compound("reading", [atom("rogue"), atom("temperature"), num(99), num(1000)]));

    const r = coord.queryFirst(compound("reading", [atom("rogue"), variable("T"), variable("V"), variable("Ts")]));
    eq(r, null, "should be rejected by policy");
    eq(coord._signalLog[0].accepted, false);
  });

  it("coordinator detects alert from received reading", () => {
    const { nodes } = createMesh(["coordinator", "sensor_1"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("sensor_1"), atom("online")]));
    coord.reactive.bump();

    // Send a dangerously high temperature
    nodes.sensor_1.send("coordinator", compound("reading", [atom("sensor_1"), atom("temperature"), num(50), num(2000)]));

    const alert = coord.queryFirst(compound("alert", [variable("N"), variable("T"), variable("L")]));
    assert(alert !== null, "should detect alert");
    eq(alert.args[0].name, "sensor_1");
    eq(alert.args[2].name, "high");
  });

  it("multiple sensors accumulate readings", () => {
    const { nodes } = createMesh(["coordinator", "s1", "s2"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.engine.addClause(compound("node_status", [atom("s2"), atom("online")]));
    coord.reactive.bump();

    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(20), num(100)]));
    nodes.s2.send("coordinator", compound("reading", [atom("s2"), atom("temperature"), num(25), num(101)]));

    const readings = coord.query(compound("reading", [variable("N"), atom("temperature"), variable("V"), variable("T")]));
    eq(readings.length, 2);
  });

  it("reading upserts (replaces old value)", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.reactive.bump();

    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(20), num(100)]));
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(30), num(200)]));

    const readings = coord.query(compound("reading", [atom("s1"), atom("temperature"), variable("V"), variable("T")]));
    eq(readings.length, 1, "should have only one reading");
    eq(readings[0].args[2].value, 30, "should be the latest value");
  });

  it("coordinator broadcasts threshold to sensor nodes", () => {
    const { nodes } = createMesh(["coordinator", "s1", "s2"]);

    // Coordinator sends threshold update to sensor nodes
    const newThreshold = compound("threshold", [atom("temperature"), num(5), num(40)]);
    nodes.coordinator.send("s1", newThreshold);
    nodes.coordinator.send("s2", newThreshold);

    // Both sensors should have accepted the threshold
    for (const id of ["s1", "s2"]) {
      eq(nodes[id]._signalLog[0].accepted, true);
      // Verify upserted
      const r = nodes[id].queryFirst(compound("threshold", [atom("temperature"), variable("Min"), variable("Max")]));
      assert(r !== null, `${id} should have threshold`);
      eq(r.args[1].value, 5);
      eq(r.args[2].value, 40);
    }
  });

  it("node_status signal auto-registers sensor", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    // Sensor announces itself
    nodes.s1.send("coordinator", compound("node_status", [atom("s1"), atom("online")]));

    const r = coord.queryFirst(compound("node_status", [atom("s1"), variable("S")]));
    assert(r !== null);
    eq(r.args[1].name, "online");

    // Now readings should be accepted
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(22), num(100)]));
    const reading = coord.queryFirst(compound("reading", [atom("s1"), variable("T"), variable("V"), variable("Ts")]));
    assert(reading !== null, "reading should be accepted after registration");
  });

  it("spoofed From is rejected by policy", () => {
    const { nodes } = createMesh(["coordinator", "s1", "evil"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.reactive.bump();

    // evil sends a reading claiming to be from s1
    nodes.evil.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(99), num(1000)]));

    const r = coord.queryFirst(compound("reading", [atom("s1"), variable("T"), variable("V"), variable("Ts")]));
    eq(r, null, "spoofed reading should be rejected");
    eq(coord._signalLog[0].accepted, false);
  });
});

// ── send/2 builtin ──────────────────────────────────────────

describe("send/2 builtin", () => {
  it("coordinator auto-sends alert_notice on high reading", () => {
    const e = buildReactiveKB("coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(50), num(1000)]);
    var result = e.queryWithSends(signalObject("s1", fact));
    eq(result.sends.length, 1, "should send alert_notice");
    eq(result.sends[0].target.name, "gateway");
    eq(result.sends[0].fact.functor, "alert_notice");
  });

  it("coordinator produces no sends for normal reading", () => {
    const e = buildReactiveKB("coordinator");
    e.addClause(compound("node_status", [atom("s1"), atom("online")]));
    const fact = compound("reading", [atom("s1"), atom("temperature"), num(22), num(1000)]);
    var result = e.queryWithSends(signalObject("s1", fact));
    eq(result.sends.length, 0, "no sends for normal reading");
  });

  it("alert flows to gateway node via send/2", () => {
    const { nodes } = createMesh(["coordinator", "s1", "gateway"]);
    const coord = nodes.coordinator;
    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.reactive.bump();

    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(99), num(1000)]));

    const gwAlert = nodes.gateway.queryFirst(
      compound("alert_notice", [variable("N"), variable("T"), variable("L")]));
    assert(gwAlert !== null, "gateway should have alert_notice via send/2");
    eq(gwAlert.args[2].name, "high");
  });

  it("send/2 captures messages during query", () => {
    const e = new PrologEngine();
    loadString(e, "test :- send(target, hello).");
    var result = e.queryWithSends(compound("test", []));
    assert(result.result !== null, "query should succeed");
    eq(result.sends.length, 1);
    eq(result.sends[0].target.name, "target");
    eq(result.sends[0].fact.name, "hello");
  });

  it("multiple sends accumulate", () => {
    const e = new PrologEngine();
    loadString(e, "test :- send(a, msg1), send(b, msg2), send(c, msg3).");
    var result = e.queryWithSends(compound("test", []));
    eq(result.sends.length, 3);
    eq(result.sends[0].target.name, "a");
    eq(result.sends[1].target.name, "b");
    eq(result.sends[2].target.name, "c");
  });

  it("sends are empty when query fails", () => {
    const e = new PrologEngine();
    var result = e.queryWithSends(compound("nonexistent", []));
    eq(result.result, null);
    eq(result.sends.length, 0);
  });

  it("queryWithSends clears sends between calls", () => {
    const e = new PrologEngine();
    loadString(e, "test :- send(target, hello).");
    var r1 = e.queryWithSends(compound("test", []));
    eq(r1.sends.length, 1);
    var r2 = e.queryWithSends(compound("test", []));
    eq(r2.sends.length, 1);
  });
});

// ── Reactive layer ──────────────────────────────────────────

describe("Reactive integration", () => {
  it("alert memo recomputes when reading arrives", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.reactive.bump();

    // Create reactive alert query
    const alerts = coord.reactive.createQuery(() =>
      compound("alert", [variable("N"), variable("T"), variable("L")])
    );

    eq(alerts().length, 0, "no alerts initially");

    // Send high temperature
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(50), num(1000)]));

    eq(alerts().length, 1, "alert should fire");
    eq(alerts()[0].args[2].name, "high");
  });

  it("mesh_status transitions from normal to critical", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.reactive.bump();

    const status = coord.reactive.createQueryFirst(() =>
      compound("mesh_status", [variable("S")])
    );

    eq(status().args[0].name, "normal");

    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(99), num(1000)]));

    eq(status().args[0].name, "critical");
  });

  it("effect fires on state change", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    coord.engine.addClause(compound("node_status", [atom("s1"), atom("online")]));
    coord.reactive.bump();

    let effectCount = 0;
    coord.reactive.onUpdate(() => { effectCount++; });

    const before = effectCount;
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(22), num(100)]));
    assert(effectCount > before, "effect should have fired");
  });

  it("online_nodes updates when status changes", () => {
    const { nodes } = createMesh(["coordinator", "s1", "s2"]);
    const coord = nodes.coordinator;

    const onlineNodes = coord.reactive.createQueryFirst(() =>
      compound("online_nodes", [variable("N")])
    );

    eq(listToArray(onlineNodes().args[0]).length, 0, "no nodes initially");

    nodes.s1.send("coordinator", compound("node_status", [atom("s1"), atom("online")]));
    eq(listToArray(onlineNodes().args[0]).length, 1);

    nodes.s2.send("coordinator", compound("node_status", [atom("s2"), atom("online")]));
    eq(listToArray(onlineNodes().args[0]).length, 2);
  });
});

// ── End-to-end scenario ─────────────────────────────────────

describe("End-to-end scenario", () => {
  it("full mesh lifecycle: register, read, alert, update threshold", () => {
    const { nodes } = createMesh(["coordinator", "s1", "s2"]);
    const coord = nodes.coordinator;

    // 1. Sensors announce themselves
    nodes.s1.send("coordinator", compound("node_status", [atom("s1"), atom("online")]));
    nodes.s2.send("coordinator", compound("node_status", [atom("s2"), atom("online")]));

    const online = coord.queryFirst(compound("online_nodes", [variable("N")]));
    eq(listToArray(online.args[0]).length, 2);

    // 2. Sensors send normal readings
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(22), num(100)]));
    nodes.s2.send("coordinator", compound("reading", [atom("s2"), atom("temperature"), num(24), num(101)]));

    let status = coord.queryFirst(compound("mesh_status", [variable("S")]));
    eq(status.args[0].name, "normal");

    // 3. Sensor 1 sends a high reading → alert
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(50), num(200)]));

    status = coord.queryFirst(compound("mesh_status", [variable("S")]));
    eq(status.args[0].name, "critical");

    const alert = coord.queryFirst(compound("alert", [variable("N"), variable("T"), variable("L")]));
    eq(alert.args[0].name, "s1");
    eq(alert.args[2].name, "high");

    // 4. Update threshold to be more lenient (direct engine manipulation)
    coord.engine.retractFirst(compound("threshold", [atom("temperature"), variable("A"), variable("B")]));
    coord.engine.addClause(compound("threshold", [atom("temperature"), num(0), num(60)]));
    coord.reactive.bump();

    // Now 50 is within range — no more alert
    status = coord.queryFirst(compound("mesh_status", [variable("S")]));
    eq(status.args[0].name, "normal");
  });

  it("node goes offline, subsequent readings rejected", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    // Register and send a reading
    nodes.s1.send("coordinator", compound("node_status", [atom("s1"), atom("online")]));
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(22), num(100)]));
    assert(coord.queryFirst(compound("reading", [atom("s1"), variable("T"), variable("V"), variable("Ts")])) !== null);

    // Node goes offline (direct engine manipulation for test setup)
    coord.engine.retractFirst(compound("node_status", [atom("s1"), variable("S")]));
    coord.engine.addClause(compound("node_status", [atom("s1"), atom("offline")]));
    coord.reactive.bump();

    // New reading should be rejected (node not online)
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(30), num(200)]));

    // The old reading should still be there, not updated
    const r = coord.queryFirst(compound("reading", [atom("s1"), atom("temperature"), variable("V"), variable("Ts")]));
    eq(r.args[2].value, 22, "should still have old reading");
  });

  it("signal log tracks all decisions", () => {
    const { nodes } = createMesh(["coordinator", "s1"]);
    const coord = nodes.coordinator;

    // Unknown sensor → dropped
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(22), num(100)]));
    eq(coord._signalLog[0].accepted, false);

    // Register → accepted
    nodes.s1.send("coordinator", compound("node_status", [atom("s1"), atom("online")]));
    eq(coord._signalLog[1].accepted, true);

    // Now reading accepted
    nodes.s1.send("coordinator", compound("reading", [atom("s1"), atom("temperature"), num(22), num(100)]));
    eq(coord._signalLog[2].accepted, true);

    eq(coord._signalLog.length, 3);
  });
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n  ${_pass} passing, ${_fail} failing`);
if (_fail > 0) process.exit(1);
