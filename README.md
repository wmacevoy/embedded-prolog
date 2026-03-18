# y8 — Ephemeral Reactive Prolog

[![test](https://github.com/wmacevoy/wyatt/actions/workflows/test.yml/badge.svg)](https://github.com/wmacevoy/wyatt/actions/workflows/test.yml)

Events flow through pattern-matched rules.  QJSON objects are
terms.  Exact numerics survive the round-trip.  Fossilize locks
the rules.  Native hooks connect to the world.

JavaScript.  Python.  C.  Same engine, ~300 lines each.

```
./test.sh          # 25 suites, 750+ tests: C + Python + JavaScript
```

Zero dependencies.  No package managers.  No build tools.

## Three primitives

```prolog
% ephemeral — transient event, never in DB, triggers react rules
ephemeral({type: signal, from: sensor1, value: 35}).

% react — pattern-matched rules that fire on events and mutations
react({type: signal, from: From, value: Val}) :-
    trusted(From),
    assert(reading(From, Val)),
    send(dashboard, {from: From, value: Val}).

react(assert(F))  :- native(db_insert(F), _Ok).   % persistence = two rules
react(retract(F)) :- native(db_remove(F), _Ok).

% native — call external tools registered by host
native(sha256(Data), Hash).
native(db_insert(Fact), Ok).
```

No frameworks.  No plugin APIs.  Just Prolog rules.

## QJSON objects as terms

The data IS the term.  No `obj([k-v,...])` ceremony:

```prolog
react(on_login({user: Name, pass: Word})) :-
    native(check_password(Name, Word), Ok),
    Ok == true,
    send(session, logged_in(Name)).
```

Objects unify by key intersection — `{user: Name}` matches
`{user: alice, age: 30}` binding `Name = alice`.

## The full stack

```
┌──────────────────────────────────────────┐
│  Your code: I/O, UI, hardware            │
│  Python / JavaScript / C / browser       │
├──────────────────────────────────────────┤
│  native hooks (persist, crypto, I/O)     │
│  send/collect (outgoing messages)        │
├──────────────────────────────────────────┤
│  y8-prolog engine (~300 lines)           │
│  ephemeral → react (pattern dispatch)    │
│  QJSON objects as first-class terms      │
├──────────────────────────────────────────┤
│  QSQL: [lo, str, hi] interval projection│
│  QJSON: N/M/L numerics + 0j blobs       │
├──────────────────────────────────────────┤
│  SQLite / SQLCipher (encrypted at rest)  │
│  WASM SQLite (browser)                   │
└──────────────────────────────────────────┘
```

## Where this is the only tool that works

### Medical devices

FDA Class II/III embedded devices need encrypted patient data at
rest, exact dosages (no float rounding on 0.125mg), reactive alerts
when vitals cross thresholds, and offline operation.

```prolog
react({type: vital, patient: P, drug: Drug, dose: Dose}) :-
    weight(P, Kg),
    max_mg_per_kg(Drug, Limit),
    Dose > Limit * Kg,
    send(alerts, {patient: P, drug: Drug, dose: Dose, alert: overdose}).
```

Fossilize locks the rules post-certification.  Single binary
on a Raspberry Pi.  Encrypted + exact + reactive + embeddable.

### Edge reasoning over ML

ML does perception.  Prolog does reasoning.  React rules connect them.

```prolog
react({type: prediction, class: fire, confidence: C}) :-
    C > 0.80M,
    wind_speed(Speed),
    Speed > 30,
    send(alerts, {action: evacuate}).
```

### Compliance engines

Tax law, GDPR, HIPAA, AML/KYC as Prolog rules.  Encrypted PII.
Reactive: when data changes, compliance checks auto-fire.

```prolog
react(assert(personal_data(User, Purpose))) :-
    \+ gdpr_compliant(User),
    send(compliance, {violation: gdpr, user: User, purpose: Purpose}).
```

Fossilize: auditors verify the rules can't be modified.

### Industrial control

```prolog
react({type: reading, vessel: V, pressure: P}) :-
    P > 150.000M,
    valve(V, closed),
    send(alarms, {alarm: overpressure, vessel: V}).
```

Exact numerics for process control.  Encrypted process recipes.
Single C binary on an RTU.

---

The pattern: **the rules are the product, not the code.**
Everything else — encryption, reactivity, persistence — is
infrastructure.  y8 handles the infrastructure.

## Project layout

```
src/
  prolog-engine.js        y8-prolog engine (~300 lines)
  prolog.py               Python engine
  parser.js               Prolog text parser + QJSON objects
  loader.js               loadString / loadFile
  qjson.js / qjson.py     QJSON: JSON + N/M/L + 0j blobs + comments
  qsql.js / qsql.py       QSQL: [lo, str, hi] interval projection

  persist.js / persist.py  SQLite/PG persistence
  persist-sqlite / pg      Adapter trio (sqlite, sqlcipher, pg)
  persist-wasm.js          WASM SQLite → persist adapter
  fossilize.js / .py       fossilize (global) + mineralize (selective)

  reactive.js / .py        Signals/memos/effects (optional sugar)
  reactive-prolog.js/.py   Reactive-query bridge (optional)
  store.js                 Key/value shim (optional)
  serve.js                 HTTP handler (optional)
  sync.js                  Term serialization + fact sync
  sync-client.js           Offline-capable sync client
  tracer.js                Query execution tracer

native/
  y8.h / y8.c              Embeddable C API (QuickJS + SQLite)
  y8_qjson.h / y8_qjson.c  QJSON parser + projection (3.5M msg/sec)
  prolog_core.h / .c        32-bit tagged terms + unification

wasm/
  Dockerfile               Emscripten build container
  wyatt_wasm.c             C helpers for SQLite WASM
  shim.js                  better-sqlite3-compatible wrapper
  build.sh                 → wasm/dist/sqlite3.{js,wasm}

test.sh                    Runs everything
```

## Quick start

### With rules

```javascript
import { PrologEngine } from './src/prolog-engine.js';
import { loadString } from './src/loader.js';

var e = new PrologEngine();
loadString(e, `
  parent(tom, bob).
  parent(tom, liz).
  parent(bob, ann).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
`);

e.query(PrologEngine.compound("grandparent",
  [PrologEngine.atom("tom"), PrologEngine.variable("Z")]));
// → grandparent(tom, ann)
```

### With QJSON

```javascript
loadString(engine, `
  price(btc, 67432.50M, 1710000000N).
  threshold(btc, above, 70000M, sell_alert).
  config({key: 0jSGVsbG8, debug: true}).
`);
// M = BigDecimal, N = BigInt, 0j = blob (JS64)
// Exact round-trip: parse → engine → persist → restore → print
```

### With persistence

```python
from persist import persist
engine = Engine()
db = persist(engine, "state.db")
# facts survive restart
```

### With QSQL typed storage

```javascript
// Per-predicate tables with [lo, str, hi] interval projection
// price(btc, 67432.50M) → table "q$price$2"
//   arg0 = 'btc', arg1_lo = 67432.5, arg1_hi = 67432.5 (exact)
persist(engine, qsqlAdapter(db));
```

### With encryption

```javascript
persist(engine, sqlcipherAdapter(db, 'secret'));
```

### Embeddable C

```c
y8_t *w = y8_open("state.db");
y8_load(w, "comfort(R) :- temperature(R,T), T > 18.");
y8_exec(w, "assert(temperature(kitchen, 22)).");
const char *r = y8_query(w, "comfort(R).");  // "comfort(kitchen)"
y8_fossilize(w);   // freeze — no injection after this
y8_close(w);
```

Full stack in one binary: QuickJS + SQLite + parser + reactive +
persist + QJSON + fossilize.  Text in, text out.

### WASM SQLite for the browser

```bash
docker compose run --rm wasm-build
# → wasm/dist/sqlite3.js + sqlite3.wasm
```

```javascript
var db = await createWasmDb("sqlite3.wasm");
persist(engine, qsqlAdapter(db));
// ACID transactions in the browser.  Interval arithmetic.
```

### fossilize + mineralize

```prolog
% mineralize: lock specific predicates
mineralize(react/1).
mineralize(threshold/4).
% price/3 still flows freely

% fossilize: lock EVERYTHING
fossilize.
```

## QJSON

JSON superset.  See `docs/qjson.md` for the full spec.

```javascript
{
  name: "thermocouple-7",       // unquoted keys
  offset: 0.003M,               // BigDecimal — exact base-10
  nonce: 42N,                   // BigInt
  calibration: 3.14159L,        // BigFloat — full precision
  key: 0jSGVsbG8,              // blob (JS64 binary)
  readings: [22.5, 23.1,],      // trailing commas
  /* nested /* block */ comments */
}
```

Valid JSON is valid QJSON.  The Prolog parser accepts QJSON
objects as terms: `{key: Value}` with key-intersection unification.

Native C: 3.5M messages/sec, arena-allocated, zero malloc.

## Examples

Each example demonstrates a different layer.  All are tested.

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

## Documentation

| Doc | Scope |
|-----|-------|
| `docs/y8-prolog.md` | Ephemeral reactive Prolog: primitives, react rules, freezing |
| `docs/qjson.md` | QJSON spec: types, grammar, canonical form, SQL schema |
| `docs/qsql.md` | Storage: projection, comparison, persistence |
| `docs/qsql-intervals.md` | Interval arithmetic deep dive |
| `docs/mineralize.md` | fossilize vs mineralize |

## License

MIT
