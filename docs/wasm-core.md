# Wyatt WASM Core — Pure C Engine for the Browser

## Architecture

The browser stack splits into two layers:

- **Native JS** — reactive, store, serve, UI glue. JIT-compiled
  by V8/SpiderMonkey/JSC. Fast enough, no WASM needed.
- **WASM** — compute-intensive core (parser, solver, QJSON) and
  encrypted storage (SQLCipher). Near-native speed, tiny binary.

```
┌──────────────────────────────────┐
│  store.js / serve.js  (native JS)│  API layer
│  reactive.js          (native JS)│  signals/memos/effects
├──────────────────────────────────┤
│  wyatt-core.wasm       (~100 KB) │  parser + solver + QJSON
│  32-bit tagged terms             │  text in → text out
│  no QuickJS, no JS runtime       │  pure C, zero deps
├──────────────────────────────────┤
│  sqlcipher.wasm        (~1.5 MB) │  encrypted storage
│  AES-256-CBC pages, PBKDF2       │  HIPAA/GDPR at rest
└──────────────────────────────────┘
```

## Why not compile the JS engine to WASM?

The JS Prolog engine (~400 lines) runs natively in the browser.
V8 JIT-compiles it. Running the same code through QuickJS-in-WASM
would be an interpreter inside a VM inside a JIT — three layers
of indirection, slower than native JS.

## Why the C core IS the WASM candidate

`prolog_core.c` uses 32-bit tagged terms:

```
JS engine:  {type:"atom", name:"btc"}  → heap alloc, GC, property lookup
C core:     0x80000003                  → integer comparison, no alloc
```

- Atoms are interned integer IDs (2-bit tag + 30-bit payload)
- Unification is integer comparison, not object traversal
- Trail-based backtracking with explicit undo, no GC pressure
- Already designed for embedded (ESP32, Raspberry Pi)

## C modules

| File | Role | Lines | Status |
|------|------|-------|--------|
| `prolog_core.c/h` | Terms, unification, trail | ~270 | exists |
| `qjson.c/h` | QJSON parser/serializer | ~400 | exists |
| `solver.c` | solve loop, builtins | ~300 | planned |
| `parser.c` | Tokenizer + Pratt + QJSON literals | ~400 | planned |
| **Total** | | **~1400** | |

Compiled to WASM: ~100-150 KB. Compare to wyatt.c (QuickJS): ~2 MB.

## WASM API

Three functions cross the boundary:

```c
// Load Prolog text: parse + add clauses
int wyatt_core_load(const char *prolog_text);

// Query: parse goal + solve + serialize first result
// Returns NULL if no solution
const char *wyatt_core_query(const char *goal_text);

// Query all solutions (up to limit)
// Returns JSON array of result strings
const char *wyatt_core_query_all(const char *goal_text, int limit);
```

Text in, text out. No JS object allocation on the WASM side.
The JS glue uses `cwrap` to call these and parses the returned
strings.

## QJSON in the C parser

The C parser handles QJSON numeric literals:

```
67432.50M  → tagged num term + repr string "67432.50M"
42N        → tagged num term + repr string "42N"
3.14L      → tagged num term + repr string "3.14L"
```

Repr stored in a side table indexed by term ID. Survives the
round-trip through termToString. Same design as the JS parser
changes (repr field on num terms).

## Solver builtins (planned)

Minimum set for the persist/serve use case:

```
assert/1, assertz/1        — add fact
retract/1, retractall/1    — remove facts
findall/3                  — collect solutions
is/2                       — arithmetic evaluation
>/2, </2, >=/2, =</2      — numeric comparison
=:=/2, =\=/2              — arithmetic equality
=/2, \=/2                 — unification
==/2, \==/2               — structural equality
\+/1, not/1               — negation as failure
!/0                        — cut
write/1, writeln/1         — output
send/2                     — message capture
ephemeral/1                — scoped assert/retract
mineralize/1               — selective hardening
member/2                   — list membership
append/3                   — list append
length/2                   — list length
```

## Build

Same container, two targets:

```bash
docker compose run --rm wasm-build          # default: sqlcipher
docker compose run --rm wasm-build core     # wyatt-core.wasm
docker compose run --rm wasm-build all      # both
```

## Performance expectations

| Operation | JS engine | C core WASM |
|-----------|-----------|-------------|
| Unification (simple) | ~1 μs | ~0.1 μs |
| 100-rule query | ~50 μs | ~5 μs |
| QJSON parse (1KB) | ~10 μs | ~0.3 μs (3.5M msg/sec) |
| Deep backtracking (1000 clauses) | ~5 ms | ~0.5 ms |

Estimated 5-10x speedup on compute-intensive workloads.
For simple KV store usage, JS engine is already fast enough.
The C core matters for compliance engines, game logic, and
high-frequency price processing.

## When to use which

| Use case | Engine | Why |
|----------|--------|-----|
| Store shim, forms, UI | JS engine | fast enough, simpler |
| 500-rule compliance check | C core WASM | 10x faster queries |
| 10K msg/sec price feed | C core WASM | throughput matters |
| Game logic with deep search | C core WASM | backtracking speed |
| Server-side (Node/Bun) | JS engine | JIT is competitive |
| Embedded C (ESP32) | prolog_core.c native | no WASM, bare metal |
