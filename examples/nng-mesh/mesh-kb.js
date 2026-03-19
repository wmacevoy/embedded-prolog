// ============================================================
// mesh-kb.js — Prolog rules for IoT sensor mesh
//
// Signal policy via react/1 rules with QJSON object terms.
// ephemeral/1 fires react clauses; no handle_signal/2 needed.
// ============================================================

import { loadString } from "../../src/loader.js";

const MESH_RULES = `
% ── Threshold defaults ───────────────────────────────────
threshold(temperature, 0, 45).
threshold(humidity, 10, 90).

% ── React rules ──────────────────────────────────────────
% Pattern-match on QJSON signal objects via ephemeral/react.
% Spoofing protection: from: From must match the From in the fact.

% Coordinator accepts readings from online sensors
react({type: signal, from: From, fact: reading(From, Type, Val, Ts)}) :-
    node_id(coordinator),
    node_status(From, online),
    retractall(reading(From, Type, _OldA, _OldB)),
    assert(reading(From, Type, Val, Ts)),
    check_alerts(From, Type).

check_alerts(Node, Type) :-
    alert(Node, Type, Level),
    send(gateway, alert_notice(Node, Type, Level)).
check_alerts(_AnyNode, _AnyType).

% Coordinator accepts node_status from anyone
react({type: signal, from: From, fact: node_status(From, Status)}) :-
    node_id(coordinator),
    retractall(node_status(From, _OldS)),
    assert(node_status(From, Status)).

% Sensor nodes accept threshold updates from coordinator
react({type: signal, from: coordinator, fact: threshold(Type, Min, Max)}) :-
    not(node_id(coordinator)),
    retractall(threshold(Type, _OldMin, _OldMax)),
    assert(threshold(Type, Min, Max)).

% Any node accepts alert_notice from coordinator
react({type: signal, from: coordinator, fact: alert_notice(Node, Type, Level)}) :-
    not(node_id(coordinator)),
    retractall(alert_notice(Node, Type, _OldL)),
    assert(alert_notice(Node, Type, Level)).

% No catch-all — unmatched signals are dropped (react fails)

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
