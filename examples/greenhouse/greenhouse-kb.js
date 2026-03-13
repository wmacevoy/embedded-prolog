// ============================================================
// greenhouse-kb.js — Prolog rules for greenhouse sensor mesh
//
// Four node roles: coordinator, sensor, estimator, gateway.
// Signal policy + alert detection + VPD + aggregation.
// ============================================================

import { loadString } from "../../src/loader.js";

const GREENHOUSE_RULES = `
% ── Threshold defaults ───────────────────────────────────
threshold(temperature, 5, 40).
threshold(humidity, 20, 85).
threshold(vpd, 40, 160).

% ── Signal policy: on_signal(From, Fact, Action) ─────────
%
% Each node role accepts different signals.
% No matching clause = signal is ignored.

% -- Coordinator --
% Accept readings from online sensors (spoofing protection)
on_signal(From, reading(From, Type, Val, Ts), assert) :-
    node_role(coordinator),
    node_status(From, online).

% Accept estimates from estimator
on_signal(estimator, estimate(Type, Node, Val, Confidence, Ts), assert) :-
    node_role(coordinator).

% Accept node_status from anyone
on_signal(From, node_status(From, Status), assert) :-
    node_role(coordinator).

% -- Estimator --
% Accept readings from online sensors
on_signal(From, reading(From, Type, Val, Ts), assert) :-
    node_role(estimator),
    node_status(From, online).

% Accept node_status
on_signal(From, node_status(From, Status), assert) :-
    node_role(estimator).

% -- Gateway --
% Accept estimates from estimator
on_signal(estimator, estimate(Type, Node, Val, Confidence, Ts), assert) :-
    node_role(gateway).

% Accept alert_notice from coordinator
on_signal(coordinator, alert_notice(Node, Type, Level), assert) :-
    node_role(gateway).

% -- Sensor --
% Accept calibration from coordinator
on_signal(coordinator, calibration(Sensor, Type, Offset), assert) :-
    node_role(sensor).

% Accept threshold updates from coordinator
on_signal(coordinator, threshold(Type, Min, Max), assert) :-
    node_role(sensor).

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

alert(Node, vpd, high) :-
    estimate(vpd, Node, Val, Confidence, Ts),
    threshold(vpd, Min, Max),
    Val > Max.

alert(Node, vpd, low) :-
    estimate(vpd, Node, Val, Confidence, Ts),
    threshold(vpd, Min, Max),
    Val < Min.

% ── Aggregation ──────────────────────────────────────────
all_alerts(Alerts) :-
    findall(alert(N, T, L), alert(N, T, L), Alerts).

node_readings(Node, Readings) :-
    findall(reading(Node, T, V, Ts), reading(Node, T, V, Ts), Readings).

online_nodes(Nodes) :-
    findall(N, node_status(N, online), Nodes).

% ── Status ───────────────────────────────────────────────
mesh_status(critical) :- alert(A, B, C).
mesh_status(normal) :- not(alert(A, B, C)).
`;

export const GREENHOUSE_PROLOG_SOURCE = GREENHOUSE_RULES;

/**
 * Build the greenhouse KB for a specific node.
 * @param {Function} PrologEngine
 * @param {string} nodeId
 * @param {string} role — "coordinator", "sensor", "estimator", "gateway"
 * @returns {PrologEngine}
 */
export function buildGreenhouseKB(PrologEngine, nodeId, role) {
  const engine = new PrologEngine();
  loadString(engine, GREENHOUSE_RULES);

  // Set this node's identity and role
  engine.addClause(PrologEngine.compound("node_id", [PrologEngine.atom(nodeId)]));
  engine.addClause(PrologEngine.compound("node_role", [PrologEngine.atom(role)]));

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
  engine.retractFirst(compound("reading", [atom(nodeId), atom(sensorType), variable("_V"), variable("_T")]));
  engine.addClause(compound("reading", [atom(nodeId), atom(sensorType), num(value), num(timestamp)]));
}

/** Set node status (upsert). */
export function setNodeStatus(engine, PrologEngine, nodeId, status) {
  const { atom, compound, variable } = PrologEngine;
  engine.retractFirst(compound("node_status", [atom(nodeId), variable("_S")]));
  engine.addClause(compound("node_status", [atom(nodeId), atom(status)]));
}

/** Update threshold (upsert). */
export function updateThreshold(engine, PrologEngine, sensorType, min, max) {
  const { atom, compound, variable, num } = PrologEngine;
  engine.retractFirst(compound("threshold", [atom(sensorType), variable("_Min"), variable("_Max")]));
  engine.addClause(compound("threshold", [atom(sensorType), num(min), num(max)]));
}

/** Update estimate (upsert). */
export function updateEstimate(engine, PrologEngine, type, nodeId, value, confidence, timestamp) {
  const { atom, compound, variable, num } = PrologEngine;
  engine.retractFirst(compound("estimate", [atom(type), atom(nodeId), variable("_V"), variable("_C"), variable("_T")]));
  engine.addClause(compound("estimate", [atom(type), atom(nodeId), num(value), num(confidence), num(timestamp)]));
}
