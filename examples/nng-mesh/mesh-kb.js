// ============================================================
// mesh-kb.js — Prolog rules for IoT sensor mesh
//
// Signal policy + alert detection + aggregation, all in Prolog.
// ============================================================

import { loadString } from "../../src/loader.js";

const MESH_RULES = `
% ── Threshold defaults ───────────────────────────────────
threshold(temperature, 0, 45).
threshold(humidity, 10, 90).

% ── Signal policy: on_signal(From, Fact, Action) ─────────
%
% A signal is just a notification. The policy decides whether
% to assert, retract, or ignore it. No clause match = ignore.

% Coordinator accepts readings from online sensor nodes
on_signal(From, reading(From, Type, Val, Ts), assert) :-
    node_id(coordinator),
    node_status(From, online).

% Coordinator accepts node_status from anyone
on_signal(From, node_status(From, Status), assert) :-
    node_id(coordinator).

% Sensor nodes accept threshold updates from coordinator
on_signal(coordinator, threshold(Type, Min, Max), assert) :-
    not(node_id(coordinator)).

% Sensor nodes accept retract of threshold from coordinator
on_signal(coordinator, threshold(Type, Min, Max), retract) :-
    not(node_id(coordinator)).

% Everything else: ignored (no matching clause)

% ── Alert detection ──────────────────────────────────────
alert(Node, temperature, high) :-
    reading(Node, temperature, Val, Ts),
    threshold(temperature, Min, Max),
    Val > Max.

alert(Node, temperature, low) :-
    reading(Node, temperature, Val, Ts),
    threshold(temperature, Min, Max),
    Val < Min.

alert(Node, humidity, high) :-
    reading(Node, humidity, Val, Ts),
    threshold(humidity, Min, Max),
    Val > Max.

alert(Node, humidity, low) :-
    reading(Node, humidity, Val, Ts),
    threshold(humidity, Min, Max),
    Val < Min.

% ── Aggregation ──────────────────────────────────────────
all_alerts(Alerts) :-
    findall(alert(N, T, L), alert(N, T, L), Alerts).

node_readings(Node, Readings) :-
    findall(reading(Node, T, V, Ts), reading(Node, T, V, Ts), Readings).

online_nodes(Nodes) :-
    findall(N, node_status(N, online), Nodes).

% ── Status summary ───────────────────────────────────────
mesh_status(critical) :- alert(A, B, C).
mesh_status(normal) :- not(alert(A, B, C)).
`;

export const MESH_PROLOG_SOURCE = MESH_RULES;

/**
 * Build the mesh KB for a specific node.
 * @param {Function} PrologEngine — the PrologEngine constructor
 * @param {string} nodeId — this node's identifier (e.g., "coordinator", "sensor_1")
 * @returns {PrologEngine} configured engine
 */
export function buildMeshKB(PrologEngine, nodeId) {
  const engine = new PrologEngine();
  loadString(engine, MESH_RULES);

  // Set this node's identity
  engine.addClause(PrologEngine.compound("node_id", [PrologEngine.atom(nodeId)]));

  // list_length/2 builtin
  engine.builtins["list_length/2"] = function(g, r, s, ctr, d, cb) {
    var lst = engine.deepWalk(g.args[0], s);
    var items = [];
    while (lst && lst.type === "compound" && lst.functor === "." && lst.args.length === 2) {
      items.push(lst.args[0]);
      lst = lst.args[1];
    }
    var u = engine.unify(g.args[1], PrologEngine.num(items.length), s);
    if (u !== null) engine.solve(r, u, ctr, d + 1, cb);
  };

  return engine;
}

// ── Helpers: update dynamic facts ───────────────────────────

/** Replace reading for a given node+type (upsert). */
export function updateReading(engine, PrologEngine, nodeId, sensorType, value, timestamp) {
  const { atom, compound, variable, num } = PrologEngine;

  // Retract any existing reading for this node+type
  engine.retractFirst(compound("reading", [atom(nodeId), atom(sensorType), variable("_V"), variable("_T")]));

  // Assert new reading
  engine.addClause(compound("reading", [atom(nodeId), atom(sensorType), num(value), num(timestamp)]));
}

/** Set node status (upsert). */
export function setNodeStatus(engine, PrologEngine, nodeId, status) {
  const { atom, compound, variable } = PrologEngine;
  engine.retractFirst(compound("node_status", [atom(nodeId), variable("_")]));
  engine.addClause(compound("node_status", [atom(nodeId), atom(status)]));
}

/** Update threshold (upsert). */
export function updateThreshold(engine, PrologEngine, sensorType, min, max) {
  const { atom, compound, variable, num } = PrologEngine;
  engine.retractFirst(compound("threshold", [atom(sensorType), variable("_Min"), variable("_Max")]));
  engine.addClause(compound("threshold", [atom(sensorType), num(min), num(max)]));
}
