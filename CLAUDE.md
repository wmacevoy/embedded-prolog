# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

y8 (Wyatt) — an encrypted reactive database that happens to use Prolog. Typed storage, reactive queries, encryption at rest, embeddable single binary. Same engine in Python, JavaScript, and C. Zero dependencies.

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
    ↕
store.js (KV shim) / serve.js (HTTP handler)     ← optional, no Prolog needed
    ↕
Reactive layer (~80 lines) — signals/memos/effects
    ↕
Prolog engine (~300 lines) — CPS-based inference with unification, backtracking
    ↕
QSQL — per-predicate typed SQLite tables with interval arithmetic
    ↕
SQLite / SQLCipher (encrypted at rest) / WASM SQLite (browser)
```

### Source modules (`src/`)

| Module | Role | Depends on |
|--------|------|------------|
| `store.js` | Key/value shim: `set/get/on/off`, no Prolog needed | engine + reactive |
| `serve.js` | HTTP handler: routes are `handle/4` Prolog rules | engine |
| `prolog-engine.js` / `prolog.py` | Core engine: unification, solve, builtins | nothing |
| `parser.js` | Prolog text parser + QJSON literals (N/M/L suffixes) | prolog-engine |
| `loader.js` | `loadString`/`loadFile` | parser |
| `reactive.js` / `reactive.py` | createSignal, createMemo, createEffect | nothing |
| `reactive-prolog.js` / `reactive_prolog.py` | Bridge: createReactiveEngine, bump, createQuery | reactive + engine |
| `sync.js` | serialize/deserialize terms, SyncEngine | engine |
| `sync-client.js` | Offline-capable sync client | sync |
| `tracer.js` | Query execution tracer | engine |
| `persist.js` / `persist.py` | SQLite/PG persistence: `persist(engine, db)` | engine + adapter |
| `persist-sqlite.js` / `persist_sqlite.py` | SQLite adapter (WAL mode) | sqlite3 |
| `persist-sqlcipher.js` / `persist_sqlcipher.py` | SQLCipher adapter (encrypted) | sqlcipher |
| `persist-pg.js` / `persist_pg.py` | PostgreSQL adapter | pg driver |
| `persist-wasm.js` | Bridge: WASM SQLite → persist adapter (browser) | WASM binary |
| `qsql.js` / `qsql.py` | QSQL: per-predicate typed columns + interval arithmetic | engine + adapter |
| `qjson.js` / `qjson.py` | QJSON: JSON + `N`/`M`/`L` bignums + comments | nothing |
| `fossilize.js` / `fossilize.py` | `fossilize()` (global freeze) + `mineralize()` (selective lock) | engine |

### Native C (`native/`)

| File | Role |
|------|------|
| `y8.h` / `y8.c` | Embeddable C API: QuickJS + SQLite. Text in, text out |
| `y8_qjson.h` / `y8_qjson.c` | QJSON parser + interval projection, arena-allocated, 3.5M msg/sec, zero malloc |
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

**Ephemeral/react** — the core signal-handling pattern:
```prolog
handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.
react :- signal(From, reading(From, Type, Val, Ts)),
         trusted(From),
         retractall(reading(From, Type, _OldV, _OldTs)),
         assert(reading(From, Type, Val, Ts)),
         send(dashboard, reading(From, Type, Val, Ts)).
```
`ephemeral/1` scopes assertion lifetime. `send/2` captures outgoing messages. `queryWithSends(goal)` collects sends without DB pollution.

**IMPORTANT:** When writing Prolog text for `loadString`, each anonymous variable must have a UNIQUE name within a clause. Bare `_` shares identity after freshening. Use `_OldV`, `_OldTs`, `_Src` etc instead of repeated `_`.

**CPS execution** — `solve(goals, subst, counter, depth, onSolution)` with callback-based flow. No generators. `queryFirst` uses exception-based early exit.

**Term representation:**
- JS: `{type:"atom", name}`, `{type:"compound", functor, args}`, `{type:"num", value, repr?}`, `{type:"var", name}`
- Python: tuples `("atom", name)`, `("compound", functor, (args,))`, `("num", value)` or `("num", value, repr)`, `("var", name)`
- C: 32-bit tagged values (tag in bits 31:30, payload in 29:0)

The optional `repr` field on num terms preserves QJSON notation (`"67432.50M"`, `"42N"`, `"3.14L"`) through the full round-trip: parse → engine → persist → qsql → restore → termToString.

**QJSON in Prolog** — the parser accepts QJSON numeric literals:
```prolog
price(btc, 67432.50M, 1710000000N).
threshold(btc, above, 70000M, sell_alert).
```
`M` = BigDecimal, `N` = BigInt, `L` = BigFloat. Lowercase accepted, canonicalized to uppercase. Suffix must not be followed by alphanumeric (to distinguish `42N` from `42Name`).

**Store shim** — key/value API hiding Prolog:
```javascript
var s = createStore();
s.set("count", 0);
s.get("count");       // 0
s.on("count", fn);    // reactive
```
Uses atomic `_kv_set` rule (retractall + assert in one query) for single-notification updates.

**HTTP handler** — routes are Prolog rules:
```javascript
var h = createHandler(engine);
var res = h.handleRequest("POST", "/api/price", body);
```
Builtins: `path_segments/2` (URL → atom list), `field/3` (JSON object field extraction). JSON ↔ Prolog: objects become `obj([key-val, ...])` compounds using `-` as the pair functor (not `:` — parser doesn't have `:` as infix operator).

**fossilize vs mineralize:**
- `fossilize(engine)` — global freeze. All clauses immutable. Only ephemeral survives. Enables embarrassingly parallel forking.
- `mineralize(engine, functor, arity)` — selective lock. Specific predicates immutable, others stay dynamic. One-way, additive. `mineralize/1` also callable from Prolog: `mineralize(threshold/4).`

**QSQL interval arithmetic** — each numeric arg stored as 3 columns:
- `arg{i}` — value as string (atom name, or exact numeric representation)
- `arg{i}_lo` — `ieee_double_round_down(exact_value)` (REAL, NULL for atoms)
- `arg{i}_hi` — `ieee_double_round_up(exact_value)` (REAL, NULL for atoms)

Exact doubles (most numbers): `lo == hi` → point interval, zero overhead. Non-exact BigNums (rare): `lo + 1 ULP == hi` → 1-ULP bracket.

Query pushdown: `(interval_accept) OR ((interval_not_reject) AND cmp <op> 0)`. Intervals accept/reject via indexed REAL; `y8_decimal_cmp` only runs in the overlap zone (~0.001%). Example: `a < b` = `(a_hi < b_lo) OR ((a_lo < b_hi) AND cmp < 0)`. For `==`: `(a_hi >= b_lo AND b_hi >= a_lo) AND cmp == 0` — intervals can never prove equality.

**Persist adapter interface** (6 methods):
```
setup(), insert(key, functor, arity), remove(key),
all(predicates), commit(), close()
```

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
