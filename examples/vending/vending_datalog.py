# ============================================================
# vending_datalog.py — Vending machine on Y8 Datalog
#
# Same policy as vending.py but using the Datalog layer:
# facts as sets, react rules as body goal lists,
# all state in SQLite.
# ============================================================

import sys, os
_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_dir, '..', '..', 'vendor', 'qjson', 'src'))
sys.path.insert(0, os.path.join(_dir, '..', '..', 'src'))

import sqlite3
from y8_datalog import Y8Datalog
from y8_loader import load_program
from qjson import Unbound


def build_vending_kb():
    conn = sqlite3.connect(':memory:')
    db = Y8Datalog(conn)
    db.setup()

    U = Unbound

    # ── Products, state, sensors, inventory ────────────────

    load_program(db, """
        product(a1, cola, 125).
        product(a2, water, 75).
        product(a3, juice, 150).
        product(b1, chips, 100).
        product(b2, candy, 85).
        product(b3, cookies, 110).

        machine_state(idle).
        credit(0).

        sensor(tilt, ok).
        sensor(door, closed).
        sensor(temp, normal).
        sensor(coin_mech, ready).
        sensor(motor_a1, ready).
        sensor(motor_a2, ready).
        sensor(motor_a3, ready).
        sensor(motor_b1, ready).
        sensor(motor_b2, ready).
        sensor(motor_b3, ready).
        sensor(delivery, clear).
        sensor(power, ok).

        inventory(a1, 8).
        inventory(a2, 10).
        inventory(a3, 6).
        inventory(b1, 7).
        inventory(b2, 12).
        inventory(b3, 5).

        motor_for(a1, motor_a1).
        motor_for(a2, motor_a2).
        motor_for(a3, motor_a3).
        motor_for(b1, motor_b1).
        motor_for(b2, motor_b2).
        motor_for(b3, motor_b3).

        fault_response(tilt_detected, lock_and_alarm).
        fault_response(door_open, lock_and_alarm).
        fault_response(power_fault, emergency_return_credit).
        fault_response(overtemp, compressor_boost).
        fault_response(coin_jam, disable_coin_accept).
        fault_response(delivery_blocked, disable_vend).
    """)

    # ── Fault conditions (derived rules) ──────────────────

    load_program(db, """
        fault_condition(tilt_detected) :- sensor(tilt, tilted).
        fault_condition(door_open) :- sensor(door, open).
        fault_condition(overtemp) :- sensor(temp, hot).
        fault_condition(coin_jam) :- sensor(coin_mech, jammed).
        fault_condition(power_fault) :- sensor(power, low).
        fault_condition(delivery_blocked) :- sensor(delivery, blocked).
    """)

    # motor_fault — needs multi-predicate join
    load_program(db, """
        motor_fault(Slot) :- sensor(M, stuck), motor_for(Slot, M).
    """)

    # ── React rules (event handlers as body goals) ────────

    # Sensor update: retract old, assert new
    db.add_react_clause('sensor_event', [
        ['retractall', ['sensor', U('Name'), U('_Old')]],
        ['assert', ['sensor', U('Name'), U('Value')]],
    ])

    # Coin insert: check can accept, update credit
    db.add_react_clause('coin_event', [
        # Check: idle, no critical fault, coin mech ready
        ['machine_state', U('_S')],  # bind to check it exists
        ['sensor', U('_CM'), U('_CMV')],  # will check below
        ['credit', U('Old')],
        ['is', U('New'), ['+', U('Old'), U('Amt')]],
        ['retract', ['credit', U('Old')]],
        ['assert', ['credit', U('New')]],
    ])

    # Select slot: check can vend, debit, update inventory, change state
    db.add_react_clause('select_event', [
        ['machine_state', U('idle')],  # placeholder - checked below
        ['product', U('Slot'), U('_Name'), U('Price')],
        ['credit', U('Credit')],
        ['>=', U('Credit'), U('Price')],
        ['inventory', U('Slot'), U('Count')],
        ['>', U('Count'), 0],
        ['is', U('Change'), ['-', U('Credit'), U('Price')]],
        ['retract', ['credit', U('Credit')]],
        ['assert', ['credit', U('Change')]],
        ['is', U('NC'), ['-', U('Count'), 1]],
        ['retract', ['inventory', U('Slot'), U('Count')]],
        ['assert', ['inventory', U('Slot'), U('NC')]],
        ['retract', ['machine_state', U('_')]],
        ['assert', ['machine_state', 'vending']],
    ])

    # Vend complete: back to idle
    db.add_react_clause('vend_complete_event', [
        ['machine_state', U('vending')],  # placeholder
        ['retract', ['machine_state', 'vending']],
        ['assert', ['machine_state', 'idle']],
    ])

    # Return credit
    db.add_react_clause('return_credit_event', [
        ['credit', U('C')],
        ['>', U('C'), 0],
        ['sensor', U('_'), U('_')],  # placeholder
        ['retract', ['credit', U('C')]],
        ['assert', ['credit', 0]],
    ])

    return db


# ── Event helpers ─────────────────────────────────────────

def sensor_event(db, name, value):
    """Fire a sensor event."""
    bindings = {'Name': name, 'Value': value}
    db.execute_body([
        ['retractall', ['sensor', name, Unbound('_Old')]],
        ['assert', ['sensor', name, value]],
    ], bindings)

def coin_event(db, amount):
    """Fire a coin event."""
    bindings = {'Amt': amount}
    db.execute_body([
        ['credit', Unbound('Old')],
        ['is', Unbound('New'), ['+', Unbound('Old'), amount]],
        ['retract', ['credit', Unbound('Old')]],
        ['assert', ['credit', Unbound('New')]],
    ], bindings)

def select_event(db, slot):
    """Fire a select event."""
    bindings = {'Slot': slot}
    # Check can vend
    state = db.query('machine_state')
    if not state or state[0][0] != 'idle':
        return

    # Check no faults
    faults = get_faults(db)
    if faults:
        return

    # Check motor not stuck for this slot
    motor_name = 'motor_' + slot
    motor_sensor = db.query('sensor', [motor_name, None])
    if motor_sensor and motor_sensor[0][1] == 'stuck':
        return

    # Check delivery clear
    delivery = db.query('sensor', ['delivery', None])
    if delivery and delivery[0][1] != 'clear':
        return

    product = db.query('product', [slot, None, None])
    if not product:
        return
    price = product[0][2]

    credit = db.query('credit')
    if not credit:
        return
    credit_val = credit[0][0]

    if credit_val < price:
        return

    inv = db.query('inventory', [slot, None])
    if not inv or inv[0][1] <= 0:
        return

    db.execute_body([
        ['is', Unbound('Change'), ['-', credit_val, price]],
        ['retract', ['credit', credit_val]],
        ['assert', ['credit', Unbound('Change')]],
        ['is', Unbound('NC'), ['-', inv[0][1], 1]],
        ['retract', ['inventory', slot, inv[0][1]]],
        ['assert', ['inventory', slot, Unbound('NC')]],
        ['retract', ['machine_state', 'idle']],
        ['assert', ['machine_state', 'vending']],
    ], bindings)

def vend_complete_event(db):
    """Fire vend complete event."""
    state = db.query('machine_state')
    if state and state[0][0] == 'vending':
        db.retract('machine_state', ['vending'])
        db.assert_fact('machine_state', ['idle'])

def return_credit_event(db):
    """Fire return credit event."""
    credit = db.query('credit')
    if credit and credit[0][0] > 0:
        sensor = db.query('sensor', ['coin_mech', None])
        if sensor and sensor[0][1] == 'ready':
            db.retract('credit', [credit[0][0]])
            db.assert_fact('credit', [0])


# ── Query helpers ─────────────────────────────────────────

def get_credit(db):
    r = db.query('credit')
    return r[0][0] if r else 0

def get_state(db):
    r = db.query('machine_state')
    return r[0][0] if r else '?'

def get_faults(db):
    faults = []
    fault_checks = [
        ('tilt_detected', 'tilt', 'tilted'),
        ('door_open', 'door', 'open'),
        ('overtemp', 'temp', 'hot'),
        ('coin_jam', 'coin_mech', 'jammed'),
        ('power_fault', 'power', 'low'),
        ('delivery_blocked', 'delivery', 'blocked'),
    ]
    for fault_name, sensor_name, sensor_val in fault_checks:
        r = db.query('sensor', [sensor_name, None])
        if r and r[0][1] == sensor_val:
            faults.append(fault_name)
    return faults

def get_display(db):
    faults = get_faults(db)
    if 'tilt_detected' in faults:
        return 'OUT OF ORDER'
    if 'door_open' in faults:
        return 'SERVICE DOOR OPEN'
    if 'power_fault' in faults:
        return 'POWER LOW'
    if 'coin_jam' in faults:
        return 'COIN JAMMED'
    if 'overtemp' in faults:
        return 'TEMP WARNING'
    delivery = db.query('sensor', ['delivery', None])
    if delivery and delivery[0][1] == 'blocked':
        return 'REMOVE ITEM'
    state = get_state(db)
    if state == 'vending':
        return 'VENDING...'
    credit = get_credit(db)
    if state == 'idle' and credit == 0 and not faults:
        return 'INSERT COINS'
    if state == 'idle' and credit > 0 and not faults:
        return 'SELECT ITEM'
    return '?'

def can_vend(db, slot):
    if get_state(db) != 'idle':
        return False
    if get_faults(db):
        return False
    product = db.query('product', [slot, None, None])
    if not product:
        return False
    price = product[0][2]
    credit = get_credit(db)
    if credit < price:
        return False
    inv = db.query('inventory', [slot, None])
    if not inv or inv[0][1] <= 0:
        return False
    motor_name = 'motor_' + slot
    motor = db.query('sensor', [motor_name, None])
    if motor and motor[0][1] == 'stuck':
        return False
    delivery = db.query('sensor', ['delivery', None])
    if delivery and delivery[0][1] != 'clear':
        return False
    return True

def get_available(db):
    slots = []
    for slot in ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']:
        if can_vend(db, slot):
            slots.append(slot)
    return slots
