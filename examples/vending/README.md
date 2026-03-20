# Vending Machine Controller

A full vending machine with 12 sensors, 6 product slots, credit handling, and
automatic fault detection — all driven by Prolog rules instead of if/else chains.

All external inputs are ephemeral events.  No imperative state mutation from
the host.  The Prolog engine owns the state.

## Events

```prolog
% Sensor reading changed
ephemeral({type: sensor, name: tilt, value: tilted}).

% Coin inserted
ephemeral({type: coin, amount: 25}).

% User selected a slot
ephemeral({type: select, slot: a1}).

% Motor confirmed delivery
ephemeral({type: vend_complete}).

% User pressed return
ephemeral({type: return_credit}).
```

## React rules handle everything

```prolog
% Sensor update — retract old, assert new
react({type: sensor, name: Name, value: Value}) :-
    retractall(sensor(Name, _OldVal)),
    assert(sensor(Name, Value)).

% Coin insertion — only if machine can accept
react({type: coin, amount: Amt}) :-
    can_accept_coin,
    credit(Old), New is Old + Amt,
    retract(credit(Old)), assert(credit(New)).

% Selection — vend if all 8 conditions hold
react({type: select, slot: Slot}) :-
    can_vend(Slot),
    product(Slot, _Name, Price),
    credit(Old), Change is Old - Price,
    retract(credit(Old)), assert(credit(Change)),
    inventory(Slot, Count), NewCount is Count - 1,
    retract(inventory(Slot, Count)),
    assert(inventory(Slot, NewCount)),
    retract(machine_state(idle)),
    assert(machine_state(vending)).
```

## What it demonstrates

- **Complex policy logic**: `can_vend(Slot)` checks 8 conditions (idle state,
  no faults, credit >= price, inventory > 0, motor ok, delivery clear)
- **Derived fault detection**: `fault_condition(Fault)` fires from raw sensor
  readings (tilt, door open, over-temp, coin jam, power, delivery blocked)
- **Context-sensitive display**: `display_message(Msg)` changes based on machine
  state (INSERT COINS, SELECT ITEM, OUT OF ORDER, etc.)
- **Ephemeral events**: all inputs via `ephemeral({type: ...})` — no host-side
  state mutation
- **QJSON objects as terms**: events are `{type: sensor, name: tilt, value: tilted}`
  with key-intersection unification
- **Reactive layer**: memos automatically recompute when sensor facts change

## Files

| File | Language | Description |
|------|----------|-------------|
| `vending.py` | Python | Knowledge base (programmatic API) |
| `vending-kb.js` | JavaScript | Knowledge base (loadString) |
| `test.py` | Python | 19 tests |
| `test.js` | JavaScript | 22 tests |

## Run

```bash
# Python
python3 examples/vending/test.py

# JavaScript (any runtime)
node examples/vending/test.js
bun run examples/vending/test.js
deno run examples/vending/test.js
qjs --module examples/vending/test.js
```
