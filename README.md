# Y@ — Wyatt Ephemeral Reactive Prolog

🤠 *Y'all — lasso your facts, corral your signals.*

A Prolog inference engine with reactive bindings for embedded
systems, web apps, and everything in between.

Python.  JavaScript.  C.  Same engine, same API, same tests.

```
./test.sh          # 19 suites, 500+ tests: C + Python + JavaScript
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

  parser.js               Prolog text parser (94 tests)
  loader.js               loadString / loadFile
  sync.js                 Term serialization + fact sync
  sync-client.js          Offline-capable sync client
  tracer.js               Query execution tracer
  persist.js / persist.py SQLite/PG persistence — one function call
  persist-sqlite / pg     Adapter trio (sqlite, sqlcipher, pg)
  qjson.js / qjson.py     QJSON: JSON + NML bignums + comments
  fossilize.js / .py      Freeze clause DB — injection proof

native/
  wyatt.h / wyatt.c       Embeddable C API (QuickJS + SQLite)
  qjson.h / qjson.c       Native QJSON (arena, 3.5M msg/sec, zero malloc)
  prolog_core.h / .c      32-bit tagged terms + unification
  test_core.c             C term tests (19 tests)
  test_qjson.c            C QJSON tests + benchmark (30 tests)
  test_wyatt.c            Embeddable integration tests (14 tests)

examples/
  tutorial/               Progressive tutorial — 9 steps
  vending/                Vending machine controller
    vending.py + test.py      Python: 17 tests
    vending-kb.js + test.js   JavaScript: 22 tests
  router/                 IoT message router (failover)
    router.py + test.py       Python: 28 tests
  margin/                 Margin trading triggers
    margin-kb.js + test.js    JavaScript: 28 tests (QuickJS BigDecimal)
  nng-mesh/               IoT sensor mesh (40 tests)
  greenhouse/             Multi-runtime IoT — C + JS + Python (52 tests)
  sync-todo/              Collaborative todos over WebSocket (33 tests)
  form/                   SolidJS form validator (browser)
  tictactoe/              Tic-tac-toe with Prolog AI (browser)
  adventure/              Text adventure — world as Prolog facts (browser)

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
var atom = PrologEngine.atom, compound = PrologEngine.compound;
var variable = PrologEngine.variable, num = PrologEngine.num;

var e = new PrologEngine();
e.addClause(compound("parent", [atom("tom"), atom("bob")]));
e.addClause(compound("parent", [atom("tom"), atom("liz")]));

var results = e.query(compound("parent", [atom("tom"), variable("X")]));
```

### With the text parser

Write standard Prolog syntax and load it with `loadString`:

```javascript
import { PrologEngine } from './src/prolog-engine.js';
import { loadString } from './src/loader.js';

var e = new PrologEngine();
loadString(e, `
  parent(tom, bob).
  parent(tom, liz).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
`);

var results = e.query(
  PrologEngine.compound("grandparent", [PrologEngine.variable("X"), PrologEngine.atom("liz")])
);
```

### With reactivity

```python
from reactive_prolog import ReactiveEngine

rp = ReactiveEngine(engine)
display = rp.query_first(lambda: compound("display_message", [var("M")]))

# display() is now a live value.
# When you call rp.bump() after changing facts, it recomputes.
```

### Ephemeral/react signal handling

`ephemeral/1` is a scoped assertion: it asserts a fact, solves
the continuation, then automatically retracts it.  Combined
with user-defined `react` rules, this gives a clean pattern
for accepting or dropping external signals:

```prolog
handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.

% Accept temperature readings from trusted sensors,
% then forward to dashboard via send/2
react :- signal(From, temperature(From, Room, Val)),
         trusted_sensor(From),
         retractall(temperature(Room, _)),
         assert(temperature(Room, Val)),
         send(dashboard, temperature(Room, Val)).

% No catch-all — unmatched signals are dropped
```

Spoofing protection comes for free: `signal(From, temperature(From, ...))`
forces the transport-tagged sender to match the fact's claimed origin
via Prolog unification.

`send/2` is a side-effect builtin (like `write/1`) that captures
`(target, fact)` pairs into a buffer during query execution.  Use
`engine.queryWithSends(goal)` to run the query and collect all sends:

```javascript
var result = engine.queryWithSends(
  compound("handle_signal", [atom("sensor_1"), fact])
);
// result.result  — query result (null if dropped)
// result.sends   — [{target, fact}, ...] from send/2 calls
// result.output  — output from write/1 calls
```

React rules express the complete response — what to store AND what to
send — so the host only needs to dispatch the accumulated messages.

### Persistence

One function call makes assert/retract durable:

```python
from persist import persist
engine = Engine()
db = persist(engine, "state.db")
# done — facts survive restart, ephemeral = SQL transaction
```

```javascript
persist(engine, new Database('state.db'));
```

Hooks the engine transparently.  All dynamic facts (assert/retract,
addClause, retractFirst) write through to SQLite or PostgreSQL.
Ephemeral scopes become SQL transactions — all mutations inside one
signal handler commit atomically.  Crash mid-ephemeral → rollback.

Optional QJSON codec for BigInt/BigDecimal/BigFloat terms:

```python
persist(engine, "state.db", codec="qjson")
```

### QJSON — zero impedance messaging

JSON superset using QuickJS bignum syntax.  No collisions with JSON.

```javascript
{
  // sensor calibration config
  name: "thermocouple-7",       // unquoted keys
  offset: 0.003M,               // BigDecimal — arbitrary precision base-10
  nonce: 42N,                   // BigInt — arbitrary precision integer
  calibration: 3.14159L,        // BigFloat — arbitrary precision base-2
  readings: [22.5, 23.1,],      // trailing commas
  /* nested /* block */ comments */
}
```

Parse accepts uppercase or lowercase suffixes (`N`/`n`, `M`/`m`,
`L`/`l`).  Serialize always uses uppercase — consistent and visible.
Valid JSON is valid QJSON.

When used as a persist codec, the read path tries native `JSON.parse`
first (C, fast) and falls back to the QJSON parser only when needed.
Cost for the 99.999% of data that is plain JSON: zero.

## Examples

### Tutorial (JS)

Nine progressive steps from facts to reactive signals, using a
smart thermostat theme.  Start here.

```
node examples/tutorial/01-facts.js     # run any step individually
node examples/tutorial/test.js         # 30 tests
```

### Vending machine (Python + JS)

12 sensors, 6 product slots, fault detection, credit handling,
context-sensitive display messages.

```
python examples/vending/test.py     # 17 tests
node examples/vending/test.js       # 22 tests
```

### IoT message router (Python)

Failover routing across 4 channels (WiFi, Cellular, LoRa, BLE)
with battery-aware backoff.  ~72 states, ~25 Prolog clauses.

```
python examples/router/test.py      # 28 tests
```

### Margin trading (JS)

Position tracking, P&L, margin ratio thresholds, trigger
conditions.  QuickJS BigDecimal support for precise decimals.

```
node examples/margin/test.js        # 28 tests
```

### Form validator (browser)

SolidJS signup form with Prolog-powered real-time validation.
Password strength, cross-field dependencies, contextual hints.

```
open examples/form/index.html
```

### Tic-tac-toe (browser)

Human vs. AI where the AI strategy is entirely Prolog rules:
win → block → center → corners.

```
open examples/tictactoe/tictactoe.html
```

### Text adventure (browser)

"The Obsidian Tower" — rooms, items, NPCs, inventory, dialogue,
all modeled as Prolog facts and rules.

```
open examples/adventure/adventure.html
```

### Sync todos (JS)

Collaborative todo list with WebSocket fact synchronization.
Shared Prolog rules on server and client, SolidJS reactive UI.

```
node examples/sync-todo/test.js     # 33 tests
```

### NNG sensor mesh (JS)

IoT sensor mesh with signal policy layer, spoofing protection
via unification, and reactive aggregation.

```
node examples/nng-mesh/test.js      # 40 tests
```

### Greenhouse (C + JS + Python, Docker)

Multi-runtime IoT greenhouse: C sensor, JS estimator + dashboard,
Python gateway.  UDP mesh, VPD estimation, reactive alerts,
ephemeral/react signal policy across all nodes.

```
node examples/greenhouse/test.js    # 52 tests (no Docker needed)
cd examples/greenhouse && docker compose up --build   # full mesh
```

## Embeddable C

The full Y@ stack in 4 lines of C:

```c
wyatt_t *w = wyatt_open("state.db");  // NULL for no persistence
wyatt_load(w, "comfort(R) :- temperature(R,T), T > 18.");
wyatt_exec(w, "assert(temperature(kitchen, 22)).");
const char *r = wyatt_query(w, "comfort(R).");  // "comfort(kitchen)"
wyatt_fossilize(w);   // freeze — no Prolog injection after this
wyatt_close(w);
```

Under the hood: QuickJS runs the full JS engine (parser, reactive,
persist, qjson, fossilize).  Text in, text out.  ~300 lines of C glue.

Native QJSON (`qjson.c`) is standalone C — 3.5M messages/sec,
arena-allocated, zero malloc per parse:

```c
qj_arena a; qj_arena_init(&a, buf, sizeof(buf));
qj_val *v = qj_parse(&a, "{name: \"sensor\", offset: 0.003M}", len);
printf("%s\n", qj_str(qj_obj_get(v, "name")));  // sensor
qj_arena_reset(&a);  // ready for next message, zero free
```

See `examples/native-demo/` for complete examples.

Requires QuickJS + SQLite3 for `wyatt.c`.  `qjson.c` has no
dependencies.

## Platform matrix

| Platform        | Engine        | Reactive | Persist | Run with |
|----------------|---------------|----------|---------|----------|
| CPython 3.7+    | `prolog.py`   | `reactive.py` | SQLite/PG | `python` |
| MicroPython     | `prolog.py`   | `reactive.py` | — | `micropython` |
| Node 18+        | `prolog-engine.js` | `reactive.js` | SQLite/PG | `node` |
| Bun             | `prolog-engine.js` | `reactive.js` | bun:sqlite | `bun` |
| QuickJS         | `prolog-engine.js` | `reactive.js` | SQLite | `qjs` |
| Browser         | (inlined in HTML)   | (inlined) | — | open `.html` |
| C/C++ (embed)   | `wyatt.c` (QuickJS) | auto-bump | SQLite | link |
| C (standalone)  | `prolog_core.c` | — | — | link |
| ESP32/RP2040    | `wyatt.c` or `prolog.py` | yes | SQLite | — |

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
