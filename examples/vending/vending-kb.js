// ============================================================
// Vending Machine Knowledge Base
//
// The entire machine policy — what to do given any combination
// of sensor state, credit, and faults — expressed as Prolog
// rules.  No imperative state machine.  No if/else chains.
// Just rules and the inference engine finds the right action.
//
// All external inputs are ephemeral events:
//   ephemeral({type: sensor, name: tilt, value: tilted}).
//   ephemeral({type: coin, amount: 25}).
//   ephemeral({type: select, slot: a1}).
//   ephemeral({type: vend_complete}).
//   ephemeral({type: return_credit}).
//
// React rules handle events, mutate state, and send responses.
// Policy rules (can_vend, fault_condition, display_message) are
// pure Prolog — no mutation, no side effects.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";

export function buildVendingKB() {
  const e = new PrologEngine();

  loadString(e, `
% ── Product catalog (static) ────────────────────────────
% product(Slot, Name, PriceCents)
product(a1, cola,    125).
product(a2, water,    75).
product(a3, juice,   150).
product(b1, chips,   100).
product(b2, candy,    85).
product(b3, cookies, 110).

% ── Initial dynamic state ───────────────────────────────
machine_state(idle).
credit(0).

% Sensors (initially all ok)
sensor(tilt,      ok).
sensor(door,      closed).
sensor(temp,      normal).
sensor(coin_mech, ready).
sensor(motor_a1,  ready).
sensor(motor_a2,  ready).
sensor(motor_a3,  ready).
sensor(motor_b1,  ready).
sensor(motor_b2,  ready).
sensor(motor_b3,  ready).
sensor(delivery,  clear).
sensor(power,     ok).

% Inventory
inventory(a1, 8).
inventory(a2, 10).
inventory(a3, 6).
inventory(b1, 7).
inventory(b2, 12).
inventory(b3, 5).

% ── Fault detection rules ───────────────────────────────
fault_condition(tilt_detected) :- sensor(tilt, tilted).
fault_condition(door_open)     :- sensor(door, open).
fault_condition(overtemp)      :- sensor(temp, hot).
fault_condition(coin_jam)      :- sensor(coin_mech, jammed).
fault_condition(power_fault)   :- sensor(power, low).
fault_condition(delivery_blocked) :- sensor(delivery, blocked).

motor_fault(Slot) :- sensor(M, stuck), motor_for(Slot, M).

motor_for(a1, motor_a1).
motor_for(a2, motor_a2).
motor_for(a3, motor_a3).
motor_for(b1, motor_b1).
motor_for(b2, motor_b2).
motor_for(b3, motor_b3).

has_any_fault :- fault_condition(_F).

has_critical_fault :- fault_condition(tilt_detected).
has_critical_fault :- fault_condition(door_open).
has_critical_fault :- fault_condition(power_fault).

all_faults(Faults) :- findall(F, fault_condition(F), Faults).

% ── Can-vend rules ──────────────────────────────────────
can_vend(Slot) :-
    machine_state(idle),
    not(has_any_fault),
    product(Slot, _Name, Price),
    credit(Credit), Credit >= Price,
    inventory(Slot, Count), Count > 0,
    not(motor_fault(Slot)),
    sensor(delivery, clear).

% vend_blocked_reason(Slot, Reason)
vend_blocked_reason(Slot, has_fault)           :- has_any_fault.
vend_blocked_reason(Slot, insufficient_credit) :- product(Slot, _N, Price), credit(Credit), Credit < Price.
vend_blocked_reason(Slot, out_of_stock)        :- inventory(Slot, 0).
vend_blocked_reason(Slot, motor_stuck)         :- motor_fault(Slot).
vend_blocked_reason(Slot, delivery_blocked)    :- sensor(delivery, blocked).
vend_blocked_reason(Slot, not_idle)            :- machine_state(S), S \\= idle.

% ── Can-accept-coin ─────────────────────────────────────
can_accept_coin :-
    machine_state(idle),
    not(has_critical_fault),
    sensor(coin_mech, ready).

% ── Can-return-credit ───────────────────────────────────
can_return_credit :- credit(C), C > 0, sensor(coin_mech, ready).

% ── React rules (event handlers) ────────────────────────

% Sensor update: retract old, assert new
react({type: sensor, name: Name, value: Value}) :-
    retractall(sensor(Name, _OldVal)),
    assert(sensor(Name, Value)).

% Coin insertion
react({type: coin, amount: Amt}) :-
    can_accept_coin,
    credit(Old),
    New is Old + Amt,
    retract(credit(Old)),
    assert(credit(New)).

% Slot selection — vend if allowed
react({type: select, slot: Slot}) :-
    can_vend(Slot),
    product(Slot, _Name, Price),
    credit(Old),
    Change is Old - Price,
    retract(credit(Old)),
    assert(credit(Change)),
    inventory(Slot, Count),
    NewCount is Count - 1,
    retract(inventory(Slot, Count)),
    assert(inventory(Slot, NewCount)),
    retract(machine_state(idle)),
    assert(machine_state(vending)).

% Vend complete — return to idle
react({type: vend_complete}) :-
    machine_state(vending),
    retract(machine_state(vending)),
    assert(machine_state(idle)).

% Return credit
react({type: return_credit}) :-
    can_return_credit,
    credit(C),
    retract(credit(C)),
    assert(credit(0)).

% ── Fault response policy ───────────────────────────────
fault_response(tilt_detected, lock_and_alarm).
fault_response(door_open, lock_and_alarm).
fault_response(power_fault, emergency_return_credit).
fault_response(overtemp, compressor_boost).
fault_response(coin_jam, disable_coin_accept).
fault_response(delivery_blocked, disable_vend).

should_return_credit_on_fault :-
    has_critical_fault, credit(C), C > 0.

% ── Display / status queries ────────────────────────────
display_message('OUT OF ORDER') :- fault_condition(tilt_detected).
display_message('SERVICE DOOR OPEN')   :- fault_condition(door_open).
display_message('POWER LOW')           :- fault_condition(power_fault).
display_message('COIN JAMMED')         :- fault_condition(coin_jam).
display_message('TEMP WARNING')        :- fault_condition(overtemp).
display_message('REMOVE ITEM')         :- sensor(delivery, blocked).
display_message('VENDING...')          :- machine_state(vending).
display_message('INSERT COINS')        :- machine_state(idle), credit(0), not(has_any_fault).
display_message('SELECT ITEM')         :- machine_state(idle), credit(C), C > 0, not(has_any_fault).

% ── Available slots ─────────────────────────────────────
available_slots(Slots) :- findall(S, can_vend(S), Slots).
  `);

  return e;
}
