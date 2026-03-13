# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Y@ (Wyatt Ephemeral Reactive Prolog) — a Prolog inference engine with reactive bindings for embedded systems and IoT. Same engine in Python, JavaScript, and C. Zero dependencies.

## Commands

```bash
# Run all 410 tests (C + Python + JS) via Docker (no local runtimes needed)
docker compose build test && docker compose run --rm test

# Run specific runtime tests
docker compose run --rm test ./test.sh c
docker compose run --rm test ./test.sh python
docker compose run --rm test ./test.sh js

# Run a single test suite directly (if runtime available)
node examples/greenhouse/test.js
python3 examples/vending/test.py
gcc -O2 -Wall -std=c11 -o native/test_core native/test_core.c native/prolog_core.c && ./native/test_core

# Run the full suite locally (auto-detects available runtimes)
./test.sh
```

## Architecture

Three-layer stack, identical in Python and JavaScript:

```
Application (your I/O, hardware, UI)
    ↕
Reactive layer (~80 lines) — signals/memos/effects turn Prolog queries into live values
    ↕
Prolog engine (~300 lines) — CPS-based inference with unification, backtracking, builtins
```

### Source modules (`src/`)

| Module | Role | Depends on |
|--------|------|------------|
| `prolog-engine.js` / `prolog.py` | Core engine: unification, solve, builtins | nothing |
| `parser.js` | Prolog text parser | prolog-engine (term types) |
| `loader.js` | `loadString`/`loadFile` | parser |
| `reactive.js` / `reactive.py` | createSignal, createMemo, createEffect | nothing |
| `reactive-prolog.js` / `reactive_prolog.py` | Bridge: createReactiveEngine, bump, createQuery | reactive + engine |
| `sync.js` | serialize/deserialize terms, SyncEngine | engine |
| `sync-client.js` | Offline-capable sync client | sync |
| `tracer.js` | Query execution tracer | engine |

The C implementation (`native/prolog_core.c`) uses 32-bit tagged terms and trail-based backtracking for <1ms queries on embedded targets.

### Key patterns

**Ephemeral/react** — the core signal-handling pattern:
```prolog
handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.
react :- signal(From, reading(From, Type, Val, Ts)),
         trusted(From),
         retractall(reading(From, Type, _, _)),
         assert(reading(From, Type, Val, Ts)),
         send(dashboard, reading(From, Type, Val, Ts)).
```
`ephemeral/1` scopes assertion lifetime. `send/2` captures outgoing messages. `queryWithSends(goal)` collects sends without DB pollution.

**CPS execution** — `solve(goals, subst, counter, depth, onSolution)` with callback-based flow. No generators. `queryFirst` uses exception-based early exit.

**Term representation:**
- JS: `{type:"atom", name}`, `{type:"compound", functor, args}`, `{type:"num", value}`, `{type:"var", name}`
- Python: tuples `("atom", name)`, `("compound", functor, (args,))`, `("num", value)`, `("var", name)`
- C: 32-bit tagged values (tag in bits 31:30, payload in 29:0)

## Constraints

**`src/` files must be portable ES5-style JavaScript:**
- `var` only (no `let`/`const`)
- `function` only (no arrows)
- No template literals, destructuring, spread, for-of, generators
- Targets: Node 12+, Bun, Deno, QuickJS, Duktape, Hermes

Files in `examples/` can use modern JS syntax (they target Node/Bun).

**No local JS runtime on this machine.** Always test via Docker:
```bash
docker compose build test && docker compose run --rm test
```
