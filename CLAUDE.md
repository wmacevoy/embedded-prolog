# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

y8 (Wyatt) — ephemeral reactive Prolog with QJSON. Events flow through pattern-matched rules. QJSON objects are terms. `[lo, str, hi]` interval projection for exact numerics. Fossilize/mineralize for security. Native hooks for external tools. Same engine in JavaScript, Python, and C. ~300 lines each. Zero dependencies.

## Commands

```bash
# Run all tests (24 suites, 700+ tests) via Docker
docker compose build test && docker compose run --rm test

# Run specific runtime tests
docker compose run --rm test ./test.sh c
docker compose run --rm test ./test.sh python
docker compose run --rm test ./test.sh js

# Run a single test suite directly (if runtime available)
node examples/crypto-sentinel/test.js
python3 examples/vending/test.py
gcc -O2 -Wall -std=c11 -o native/test_core native/test_core.c native/prolog_core.c && ./native/test_core

# Build SQLite WASM (output: wasm/dist/)
docker compose run --rm wasm-build

# Run the full suite locally (auto-detects available runtimes)
./test.sh
```

## Architecture

```
Application (your I/O, UI, hardware)
    ↕  native hooks (crypto, I/O, GPIO)
    ↕  send/collect (outgoing messages)
y8 reactive layer (y8_datalog / y8-datalog.js)
    ephemeral events → react rules (never touch SQL)
    assert/retract → set operations on predicates
    resolve → SQL joins (rules) + transitive closure (recursion)
    execute_body → is/2, not/1, findall/3, comparisons
    ↕
vendor/qjson (v1.1.3)
    QJSON format + [lo, str, hi] projection
    SQL adapter (normalized 8-table schema)
    Query translator (paths → SQL JOINs, cross-path comparison)
    Constraint solver (qjson_solve)
    Transitive closure (qjson_closure, WITH RECURSIVE)
    ↕
SQLite / SQLCipher (encrypted at rest) / WASM SQLite (browser)
```

### Source modules (`src/`)

| Module | Role | Depends on |
|--------|------|------------|
| `y8-datalog.js` / `y8_datalog.py` | Datalog engine: assert/retract/resolve/react/ephemeral/send | vendor/qjson |
| `y8-loader.js` / `y8_loader.py` | Prolog text → Datalog API calls | parser + y8-datalog |
| `parser.js` | Prolog text parser + QJSON literals (N/M/L suffixes) | nothing |

### Vendor (`vendor/`)

| Submodule | Role |
|-----------|------|
| `vendor/qjson` | QJSON: JSON + `N`/`M`/`L`/`0j`/`?` types, interval projection, SQL adapter |
| `vendor/quickjs` | QuickJS JS engine |

### Native C (`native/`)

| File | Role |
|------|------|
| `y8.h` / `y8.c` | Embeddable C API: QuickJS + SQLite. Text in, text out |
| `prolog_core.h` / `prolog_core.c` | 32-bit tagged terms, unification, trail-based backtracking |
| `y8_js_embed.h` | Auto-generated: all JS modules as C string literals |

### WASM (`wasm/`)

| File | Role |
|------|------|
| `Dockerfile` | Emscripten build container |
| `wyatt_wasm.c` | C helpers for SQLite WASM (SQLITE_TRANSIENT bindings) |
| `shim.js` | better-sqlite3-compatible wrapper over WASM |
| `build.sh` | → `wasm/dist/sqlite3.{js,wasm}` |

### Key patterns

**Three primitives** — see `docs/y8-prolog.md` for the full spec:
- `ephemeral(Event)` — transient event, never in DB, triggers `react(Event)`
- `react(Pattern)` — Prolog rules that fire on mutations and events
- `native(Call, Result)` — call external tool registered by host

**React rules** — all wiring is react rules + native hooks:
```prolog
% Persistence (two rules)
react(assert(F))  :- native(db_insert(F), _Ok).
react(retract(F)) :- native(db_remove(F), _Ok).

% Signal processing with QJSON objects as terms
react({type: signal, from: From, reading: {type: Type, value: Val}}) :-
    trusted(From),
    retractall(reading(From, Type, _V, _T)),
    assert(reading(From, Type, Val)),
    ephemeral({type: new_reading, reading_type: Type, value: Val}).

% Threshold alerting
react({type: new_reading, reading_type: Type, value: Val}) :-
    threshold(Type, above, Limit, Alert),
    Val > Limit,
    send(alerts, {alert: Alert, type: Type, value: Val}).
```

**QJSON objects as terms** — no `obj([k-v,...])` ceremony:
```prolog
react(on_login({user: Name, pass: Word})) :-
    native(check_password(Name, Word), Ok),
    Ok == true,
    send(session, logged_in(Name)).
```
Objects unify by key intersection: `{user: Name}` matches `{user: alice, age: 30}` → `Name = alice`. Symmetric. Extra keys pass through.

**IMPORTANT:** When writing Prolog text for `loadString`, each anonymous variable must have a UNIQUE name within a clause. Bare `_` shares identity after freshening. Use `_OldV`, `_OldTs`, `_Src` etc instead of repeated `_`.

**CPS execution** — `solve(goals, subst, counter, depth, onSolution)` with callback-based flow. No generators. `queryFirst` uses exception-based early exit.

**Term representation:**
- JS: `{type:"atom", name}`, `{type:"compound", functor, args}`, `{type:"num", value, repr?}`, `{type:"var", name}`, `{type:"object", pairs:[{key,value}]}`
- Python: tuples `("atom", name)`, `("compound", functor, (args,))`, `("num", value, repr?)`, `("var", name)`, `("object", ((key,value),...))`
- C: 32-bit tagged values (tag in bits 31:30, payload in 29:0)

**QJSON types in Prolog** — the parser accepts all QJSON literals:
```prolog
price(btc, 67432.50M, 1710000000N).     % BigDecimal, BigInt
config({key: 0jSGVsbG8, debug: true}).   % blob, object
```
`M` = BigDecimal, `N` = BigInt, `L` = BigFloat, `0j` = blob. See `docs/qjson.md`.

**fossilize / mineralize:**
- `fossilize` — global freeze. All clauses immutable. Ephemeral still works (no mutation). Engine becomes a pure function: events in, sends out.
- `mineralize(react/1)` — selective freeze. Lock specific predicates. One-way, additive.

**QSQL interval projection** — each numeric arg stored as `[lo, str, hi]`:
- `arg{i}_lo` REAL — `round_down(exact_value)`, NULL for atoms
- `arg{i}` TEXT — exact string repr, NULL when `lo == hi` (exact double)
- `arg{i}_hi` REAL — `round_up(exact_value)`, NULL for atoms

Equality is data identity: `lo(x)=lo(y) AND hi(x)=hi(y) AND str(x)=str(y)`. Ordering: `[lo(x) < hi(y)] AND ({hi(x) < lo(y)} OR val(x) < val(y))`. See `docs/qjson.md` and `docs/qsql.md`.

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

## Examples

| Example | What it demonstrates | Tests |
|---------|---------------------|-------|
| `tutorial/` | 9 steps from facts to reactive signals | 30 |
| `vending/` | Policy as rules (Python + JS) | 39 |
| `router/` | Failover logic (Python) | 28 |
| `margin/` | QJSON exact decimals for trading | 28 |
| `nng-mesh/` | Ephemeral/react signal policy, spoofing protection | 40 |
| `greenhouse/` | Multi-runtime IoT (C + JS + Python) | 52 |
| `sync-todo/` | WebSocket sync, offline-first, SolidJS UI | 33 |
| `crypto-sentinel/` | BTC triggers, encrypted storage, REST server | 57 |
| `form/` | Browser form validator (SolidJS) | — |
| `tictactoe/` | Browser game with Prolog AI | — |
| `adventure/` | Browser text adventure | — |
