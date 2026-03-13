# Vending Machine Controller

A full vending machine with 12 sensors, 6 product slots, credit handling, and
automatic fault detection — all driven by Prolog rules instead of if/else chains.

## What it demonstrates

- **Complex policy logic**: `can_vend(Slot)` checks 8 conditions (idle state,
  no faults, credit >= price, inventory > 0, motor ok, delivery clear)
- **Derived fault detection**: `fault_condition(Fault)` fires from raw sensor
  readings (tilt, door open, over-temp, coin jam, power, delivery blocked)
- **Context-sensitive display**: `display_message(Msg)` changes based on machine
  state (INSERT COINS, SELECT ITEM, OUT OF ORDER, etc.)
- **Dynamic state**: coin insertion and vending use `assert`/`retract` to update
  credit, inventory, and machine state
- **Reactive layer**: memos automatically recompute when sensor facts change

## Files

| File | Language | Description |
|------|----------|-------------|
| `vending.py` | Python | Knowledge base + helpers |
| `vending-kb.js` | JavaScript | Knowledge base + helpers |
| `test.py` | Python | 17 tests |
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
