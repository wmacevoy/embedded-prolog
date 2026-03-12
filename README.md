# embedded-prolog

A Prolog inference engine with reactive bindings for embedded
systems, web apps, and everything in between.

Python.  JavaScript.  C.  Same engine, same API, same tests.

```
./test.sh          # 114 tests: 19 C + 45 Python + 50 JavaScript
```

Zero dependencies.  No package managers.  No build tools.

## What this is

A small Prolog interpreter (~300 lines per language) paired with
a reactive runtime (~80 lines) that makes Prolog queries into
live, automatically-updating values.

Not a replacement for Python or JavaScript — an enhancement.
Your language handles I/O, hardware, UI, networking.  Prolog
handles **decisions**: fault logic, validation rules, access
control, configuration policy, state machine transitions.

## Project layout

```
src/
  prolog.py               Python engine
  reactive.py             Python signals/memos/effects
  reactive_prolog.py      Python reactive-query bridge

  prolog-engine.js        JavaScript engine
  reactive.js             JavaScript signals/memos/effects
  reactive-prolog.js      JavaScript reactive-query bridge

native/
  prolog_core.h           C native acceleration header
  prolog_core.c           C implementation (~270 lines)
  test_core.c             C test suite (19 tests)

examples/
  vending/                Vending machine controller
    vending.py + test.py      Python: 17 tests
    vending-kb.js + test.js   JavaScript: 22 tests
  router/                 IoT message router (failover)
    router.py + test.py       Python: 28 tests
  margin/                 Margin trading triggers
    margin-kb.js + test.js    JavaScript: 28 tests (QuickJS BigDecimal)
  form/
    index.html            SolidJS form validator (browser)
  tictactoe/              (tic-tac-toe demo)
  adventure/              (text adventure demo)

test.sh                   Runs everything
```

## The core idea

Prolog clauses are **executable specifications**.  Write the
policy once, and the inference engine handles the combinatorial
explosion of states that would be impossible to enumerate with
if/else.

```prolog
% A vending machine with 12 sensors has thousands of
% possible state combinations.  In Prolog:

can_vend(Slot) :-
    machine_state(idle),
    \+ has_any_fault,
    product(Slot, _, Price),
    credit(Credit), Credit >= Price,
    inventory(Slot, Count), Count > 0,
    \+ motor_fault(Slot),
    sensor(delivery, clear).

% Eight conditions, each stated once.
% Add a sensor?  Add one clause.
% Add a fault?   Add one fact.
```

The reactive layer connects this to real I/O:

```python
# Sensor ISR updates a Prolog fact
update_sensor(engine, "tilt", "tilted")
rp.bump()
# → display memo recomputes: "OUT OF ORDER"
# → fault effect fires: alarm.on()
# → can_vend queries return empty
# All automatic.  No manual callback wiring.
```

## Three layers, one pattern

```
┌──────────────────────────────────────┐
│  Your code: I/O, UI, hardware        │
│  Python / JavaScript / C             │
├──────────────────────────────────────┤
│  Reactive: signals → memos → effects │
│  (~80 lines, same API in Py and JS)  │
├──────────────────────────────────────┤
│  Prolog: rules, policy, inference    │
│  (~300 lines, same API in Py and JS) │
└──────────────────────────────────────┘
```

The reactive layer is what makes this more than just "embed a
Prolog interpreter."  It turns Prolog queries into **live
values** that automatically update when the underlying facts
change.

## Quick start

### Python (CPython or MicroPython)

```python
from prolog import Engine, atom, var, compound, num

e = Engine()
e.add_clause(compound("parent", [atom("tom"), atom("bob")]))
e.add_clause(compound("parent", [atom("tom"), atom("liz")]))

results = e.query(compound("parent", [atom("tom"), var("X")]))
# → [("compound", "parent", (("atom","tom"), ("atom","bob"))),
#    ("compound", "parent", (("atom","tom"), ("atom","liz")))]
```

### JavaScript (Node, QuickJS, Deno, browser)

```javascript
import { PrologEngine } from './src/prolog-engine.js';
const { atom, variable, compound, num } = PrologEngine;

const e = new PrologEngine();
e.addClause(compound("parent", [atom("tom"), atom("bob")]));
e.addClause(compound("parent", [atom("tom"), atom("liz")]));

const results = e.query(compound("parent", [atom("tom"), variable("X")]));
```

### With reactivity

```python
from reactive_prolog import ReactiveEngine

rp = ReactiveEngine(engine)
display = rp.query_first(lambda: compound("display_message", [var("M")]))

# display() is now a live value.
# When you call rp.bump() after changing facts, it recomputes.
```

## Examples

### Vending machine (Python + JS)

The full showcase.  12 sensors, 6 product slots, fault detection,
fault-specific responses, context-sensitive display messages,
per-slot motor fault isolation, credit handling, diagnostic queries.

```
python examples/vending/test.py     # 17 tests
node examples/vending/test.js       # 22 tests
```

### Form validator (browser)

A SolidJS signup form where every field is validated by Prolog
in real-time.  Password strength meter, country-dependent zip
code formats, contextual hints that update as you type, gentle
shake animations on invalid fields.

```
open examples/form/index.html
```

## C native acceleration

The `native/` directory contains a C implementation of the
hot path: term arena, atom interning, trail-based substitution,
unification, and deepWalk.

```
gcc -O2 -Wall -std=c11 -o test_core native/test_core.c native/prolog_core.c
./test_core   # 19 tests
```

The C core is optional — the pure Python and JS engines work
everywhere.  The C version is for when ~10ms/query on
MicroPython isn't fast enough (drops to <1ms).

It compiles to:
- Shared library (`.so`) for QuickJS FFI
- WASM for browser or WAMR sandbox
- MicroPython C module
- Static link into any C application

## Platform matrix

| Platform        | Engine        | Reactive | Run with              |
|----------------|---------------|----------|-----------------------|
| CPython 3.7+    | `prolog.py`   | `reactive.py` | `python`         |
| MicroPython     | `prolog.py`   | `reactive.py` | `micropython`    |
| Node 18+        | `prolog-engine.js` | `reactive.js` | `node`       |
| QuickJS         | `prolog-engine.js` | `reactive.js` | `qjs --module` |
| Deno            | `prolog-engine.js` | `reactive.js` | `deno run`     |
| Browser         | (inlined in HTML)   | (inlined) | open `.html`   |
| C/C++           | `prolog_core.c`    | —         | link or `#include` |
| ESP32/RP2040    | `prolog.py` via MicroPython, or `prolog_core.c` | — | — |

## Where Prolog wins over if/else

| Concern                  | Imperative           | Prolog               |
|-------------------------|----------------------|----------------------|
| Add a new sensor         | Touch every branch   | Add 1 clause         |
| Add a new fault type     | Modify the FSM       | Add 1 fact           |
| "Why is this blocked?"   | Write error reporting| Query existing rules  |
| Motor stuck for 1 of 6   | Per-slot if/else     | Backtracking         |
| Runtime policy update    | Recompile, reflash   | assert/retract       |
| Test all state combos    | Write 100s of tests  | Inference handles it |
| Audit the decision logic | Read 2000 lines      | Read 40 clauses      |

## License

MIT
