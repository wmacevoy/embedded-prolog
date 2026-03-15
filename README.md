# y8 — Wyatt Ephemeral Reactive Prolog

[![test](https://github.com/wmacevoy/wyatt/actions/workflows/test.yml/badge.svg)](https://github.com/wmacevoy/wyatt/actions/workflows/test.yml)

An encrypted reactive database that happens to use Prolog.

If you don't care about Prolog, the extra cost is incidental.
You get typed storage, reactive queries, encryption at rest,
and an embeddable single binary.  If you DO care about Prolog,
you get the best trigger language nobody asked for.

Python.  JavaScript.  C.  Same engine, same API, same tests.

```
./test.sh          # 24 suites, 700+ tests: C + Python + JavaScript
```

Zero dependencies.  No package managers.  No build tools.

## The simplest API

```javascript
import { createStore } from './src/store.js';

var state = createStore();

state.set("count", 0);
state.set("name", "Alice");
state.set("config", { threshold: 70000 });

state.get("count");          // 0
state.keys();                // ["count", "name", "config"]

state.on("count", function(val) {
  document.getElementById("counter").textContent = val;
});

state.set("count", 1);      // callback fires automatically
```

No Prolog.  No engines.  No terms.  Under the hood: reactive
Prolog facts, typed storage, automatic change propagation.
When you need rules, the escape hatch is `state.engine`.

## When rules matter

Prolog clauses are **executable specifications**.  Write the
policy once, and the inference engine handles the combinatorial
explosion of states that would be impossible to enumerate with
if/else.

```prolog
threshold(btc, above, 70000M, sell_alert).
threshold(btc, below, 60000M, buy_alert).

check_triggers(Symbol, Action, Price, Level) :-
    price(Symbol, Price, _Ts),
    threshold(Symbol, above, Level, Action),
    Price > Level.
```

Feed a price, get an alert.  Add a threshold, add a rule.
No imperative control flow.  QJSON `M` suffix preserves exact
decimals through the entire stack — parser, engine, storage, wire.

## The full stack

```
┌─────────────────────────────────────────┐
│  Your code: I/O, UI, hardware           │
│  Python / JavaScript / C / browser      │
├─────────────────────────────────────────┤
│  store.js  — key/value shim (optional)  │
├─────────────────────────────────────────┤
│  Reactive: signals → memos → effects    │
├─────────────────────────────────────────┤
│  Prolog: rules, triggers, inference     │
├─────────────────────────────────────────┤
│  QSQL: per-predicate typed columns      │
│  QJSON: exact decimals, BigInt, BigFloat│
├─────────────────────────────────────────┤
│  SQLCipher: AES-256 encrypted at rest   │
│  LibreSSL: TLS in transit               │
└─────────────────────────────────────────┘
```

Everything links into one binary.  Decrypted data never leaves
the process.  No serialization boundaries.

## Where this is the only tool that works

### Medical devices

FDA Class II/III embedded devices need encrypted patient data at
rest, exact dosages (no float rounding on 0.125mg), reactive alerts
when vitals cross thresholds, and offline operation in ambulances
and rural clinics.

```prolog
dosage_alert(Patient, Drug, Dose) :-
    prescribed(Patient, Drug, Dose),
    weight(Patient, Kg),
    max_mg_per_kg(Drug, Limit),
    Dose > Limit * Kg.

contraindicated(Patient, Drug) :-
    taking(Patient, Other),
    interaction(Drug, Other, severe).
```

Prolog rules for clinical decision support.  Fossilize locks the
rules post-certification — the inference engine becomes tamper-proof.
Single binary on a Raspberry Pi or embedded Linux.  Nothing else gives
you encrypted + exact + reactive + embeddable + offline in one package.

### Edge reasoning over ML

ML does perception.  Prolog does reasoning.  The reactive layer
connects them.

```prolog
alert(evacuate) :-
    prediction(fire, Confidence),
    Confidence > 0.80M,
    wind_speed(Speed),
    Speed > 30.

alert(shelter_in_place) :-
    prediction(flood, Confidence),
    Confidence > 0.70M,
    elevation(Zone, Alt),
    Alt < 10.
```

The AI industry has perception solved.  Reasoning at the edge — where
encrypted sensor data never leaves the device, where decisions must be
explainable, where latency kills — is the gap.  Runs on a Jetson, a
Pi, or a phone.

### Compliance engines

Tax law, GDPR, HIPAA, AML/KYC as Prolog rules.  Encrypted PII.
Reactive: when data changes, compliance checks auto-fire — not
batch, continuous.

```prolog
gdpr_compliant(User) :-
    consent(User, Purpose, Date),
    retention_days(Purpose, MaxDays),
    days_since(Date, Elapsed),
    Elapsed < MaxDays.

gdpr_violation(User, Purpose) :-
    personal_data(User, Purpose),
    \+ gdpr_compliant(User).
```

Fossilize: auditors verify the rules can't be modified after
deployment.  Rules are readable Prolog, not opaque code in a
vendor product.  Every regulated industry needs this.  Nobody
ships it as an embeddable library.

### Personal data vaults

Your health records, financial data, location history — encrypted,
on your device, with your inference rules.

```javascript
var me = createStore();

me.set("meetings_mon", 3);
me.set("meetings_tue", 2);
me.set("meetings_wed", 0);

// Rules over your own data, running locally
// No cloud.  No trust boundary.
```

The local-first vision, but practical.  The store IS the app.

### Industrial control

PLCs use ladder logic.  Prolog triggers are strictly more expressive.

```prolog
alarm(overpressure, Vessel) :-
    pressure(Vessel, P),
    P > 150.000M,
    valve(Vessel, closed).

emergency_shutdown(Vessel) :-
    alarm(overpressure, Vessel),
    temperature(Vessel, T),
    T > 400.
```

Exact numerics for process control.  Reactive: sensor readings
trigger rule evaluation in microseconds.  Encrypted: protects
proprietary process recipes.  Single C binary on an RTU.

### Multiplayer game logic

Rules-based games where the game rules ARE Prolog and the state
syncs offline-first.

```prolog
can_cast(Player, Spell) :-
    has_mana(Player, M),
    spell_cost(Spell, C),
    M >= C,
    \+ silenced(Player).

damage(Target, Amount) :-
    attack(Source, Target, Base),
    armor(Target, Armor),
    Amount is Base - Armor,
    Amount > 0.
```

Encrypted save states.  Reactive UI.  SyncEngine for multiplayer.
Rule correctness is money — Prolog makes it auditable.

---

The pattern across all of these: **the rules are the product,
not the code.**  Prolog makes the rules auditable, testable, and
modifiable by domain experts (clinicians, lawyers, game designers).
Everything else — encryption, reactivity, persistence, sync — is
infrastructure that y8 handles so the rules can be the focus.

## Project layout

```
src/
  store.js                Key/value shim — no Prolog needed
  serve.js                HTTP handler — routes are Prolog rules
  prolog-engine.js        JavaScript engine (~300 lines)
  prolog.py               Python engine
  reactive.js / .py       Signals/memos/effects (~80 lines)
  reactive-prolog.js/.py  Reactive-query bridge

  parser.js               Prolog text parser + QJSON literals
  loader.js               loadString / loadFile
  sync.js                 Term serialization + fact sync
  sync-client.js          Offline-capable sync client
  tracer.js               Query execution tracer

  persist.js / persist.py SQLite/PG persistence — one function call
  persist-sqlite / pg     Adapter trio (sqlite, sqlcipher, pg)
  persist-wasm.js         Bridge: WASM SQLite → persist adapter
  qsql.js / qsql.py      QSQL: per-predicate typed columns + intervals
  qjson.js / qjson.py     QJSON: JSON + NML bignums + comments
  fossilize.js / .py      fossilize (global) + mineralize (selective)

native/
  y8.h / y8.c             Embeddable C API (QuickJS + SQLite)
  y8_qjson.h / y8_qjson.c QJSON parser + interval projection (arena, 3.5M msg/sec)
  prolog_core.h / .c      32-bit tagged terms + unification

wasm/
  Dockerfile              Emscripten build container
  wyatt_wasm.c            C helpers for SQLite WASM
  shim.js                 better-sqlite3-compatible wrapper
  build.sh                → wasm/dist/sqlite3.{js,wasm}

test.sh                   Runs everything
```

## Quick start

### Effortless state (no Prolog)

```javascript
import { createStore } from './src/store.js';

var s = createStore();
s.set("temperature", 22.5);
s.on("temperature", function(val) {
  if (val > 30) console.log("too hot!");
});
s.set("temperature", 35);  // → "too hot!"
```

### With rules (Prolog)

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

### With QJSON typed prices

```javascript
loadString(engine, `
  price(btc, 67432.50M, 1710000000N).
  threshold(btc, above, 70000M, sell_alert).
`);
// 67432.50M = exact BigDecimal, not float
// 1710000000N = BigInt timestamp
// Survives: parse → engine → persist → qsql column → restore → print
```

### With persistence

```python
from persist import persist
engine = Engine()
db = persist(engine, "state.db")
# done — facts survive restart, ephemeral = SQL transaction
```

### With typed storage (QSQL)

```javascript
// Per-predicate tables with interval arithmetic
// price(btc, 67432.50M, 1710000000N) →
//   table "q$price$3": _key TEXT, arg0 TEXT, arg1 TEXT + arg1_lo/hi REAL, ...
//   Exact doubles: lo == hi (point interval).  1-ULP bracket for non-exact.
persist(engine, qsqlAdapter(db));
```

### With encryption

```javascript
// Same API, encrypted at rest
persist(engine, sqlcipherAdapter(db, 'secret'));
```

### Ephemeral/react signal handling

```prolog
handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.

react :- signal(From, reading(From, Type, Val, Ts)),
         trusted(From),
         retractall(reading(From, Type, _OldV, _OldTs)),
         assert(reading(From, Type, Val, Ts)),
         send(dashboard, reading(From, Type, Val, Ts)).
```

Spoofing protection for free: `signal(From, reading(From, ...))`
forces the transport-tagged sender to match the claimed origin
via Prolog unification.

### Embeddable C

```c
wyatt_t *w = wyatt_open("state.db");
wyatt_load(w, "comfort(R) :- temperature(R,T), T > 18.");
wyatt_exec(w, "assert(temperature(kitchen, 22)).");
const char *r = wyatt_query(w, "comfort(R).");  // "comfort(kitchen)"
wyatt_fossilize(w);   // freeze — no injection after this
wyatt_close(w);
```

Full stack in one binary: QuickJS + SQLite + parser + reactive +
persist + QJSON + fossilize.  Text in, text out.  ~300 lines of C.

### WASM SQLite for the browser

```bash
docker compose run --rm wasm-build
# → wasm/dist/sqlite3.js + sqlite3.wasm (1.2 MB)
```

```javascript
var db = await createWasmDb("sqlite3.wasm");
persist(engine, qsqlAdapter(db));
// ACID transactions in the browser.  Typed columns.  Interval arithmetic.
// Swap for SQLCipher WASM → encrypted at rest.  Same API.
```

### HTTP server (routes are rules)

```javascript
var handler = createHandler(engine);
http.createServer(function(req, res) {
  var r = handler.handleRequest(req.method, req.url, body);
  res.writeHead(r.status, r.headers);
  res.end(r.body);
});
```

```prolog
handle(get, '/api/health', _Body, response(200, ok)).
handle(post, '/api/price', Body, response(403, rejected)) :-
    field(Body, feed, Feed), \+ trusted_feed(Feed).
```

Fossilize the rules.  Hash the clause DB.  The SHA-256 IS the
audit artifact.  No injection.  REST requests are ephemeral.

### fossilize + mineralize

```javascript
// mineralize: lock specific predicates (rules are gems, data is water)
mineralize(engine, "threshold", 4);   // thresholds can't change
mineralize(engine, "react", 0);       // signal handling can't change
// price/3 still flows freely

// fossilize: lock EVERYTHING (nuclear option, parallel-safe)
fossilize(engine);
```

## Examples

The examples tell a progressive story — from first facts to
encrypted reactive servers.  Each one demonstrates a different
layer of the stack.  All are tested.

### 1. Tutorial — learn the stack (30 tests)

Nine steps from facts and queries to reactive signals, using a
smart thermostat.  Start here.

```
node examples/tutorial/test.js
```

### 2. Vending machine — policy as rules (39 tests)

12 sensors, 6 product slots, fault detection, credit handling,
context-sensitive display messages.  Shows how Prolog handles
the combinatorial explosion of states that if/else can't.
Python + JavaScript.

```
python examples/vending/test.py     # 17 tests
node examples/vending/test.js       # 22 tests
```

### 3. IoT router — failover logic (28 tests)

Routing across 4 channels (WiFi, Cellular, LoRa, BLE) with
battery-aware backoff.  ~72 possible states, ~25 Prolog clauses.
Shows rules replacing a state machine.  Python.

```
python examples/router/test.py
```

### 4. Margin trading — exact decimals (28 tests)

Position tracking, P&L, margin ratio thresholds, trigger
conditions.  QJSON BigDecimal for precise financial math.
Shows that `0.1 + 0.2 = 0.3M`, not `0.30000000000000004`.

```
node examples/margin/test.js
```

### 5. NNG sensor mesh — signal policy (40 tests)

IoT sensor mesh with signal policy layer.  Spoofing protection
via Prolog unification — `signal(From, reading(From, ...))` forces
the transport sender to match the claimed origin.  Shows the
ephemeral/react pattern for accepting or dropping signals.

```
node examples/nng-mesh/test.js
```

### 6. Greenhouse — multi-runtime IoT (52 tests)

The full IoT stack: C sensor nodes, JS estimator + dashboard,
Python gateway.  VPD estimation, reactive alerts, ephemeral/react
signal policy, cross-runtime fact sync.  Shows that the same
rules work identically in C, JavaScript, and Python.

```
node examples/greenhouse/test.js
```

### 7. Sync-todo — collaborative state (33 tests)

WebSocket fact synchronization.  Shared Prolog rules on server
and client, SolidJS reactive UI.  Shows offline-first sync with
snapshot/assert/retract protocol.  Guide for adding encrypted
storage: `examples/sync-todo/SECURE.md`.

```
node examples/sync-todo/test.js
```

### 8. Crypto sentinel — encrypted triggers (57 tests)

BTC/ETH/SOL price monitoring with QJSON exact decimals, Prolog
threshold triggers, trusted feed authentication, portfolio
valuation, reactive alerts, QSQL typed storage, SyncEngine
shared state.  Plus a full REST server where routes are Prolog
rules, fossilized and hashed for audit.

```
node examples/crypto-sentinel/test.js          # 31 tests: engine
node examples/crypto-sentinel/test-server.js   # 26 tests: HTTP handler
```

### 9. Browser apps — no build step

Three browser demos that run by opening an HTML file.  No npm,
no bundler, no server.

- **Form validator** — SolidJS signup form with real-time
  Prolog validation.  Password strength, cross-field dependencies.
  `open examples/form/index.html`

- **Tic-tac-toe** — Human vs. Prolog AI.  Strategy is entirely
  rules: win → block → center → corners.
  `open examples/tictactoe/tictactoe.html`

- **Text adventure** — "The Obsidian Tower."  Rooms, items, NPCs,
  inventory, dialogue — all Prolog facts and rules.
  `open examples/adventure/adventure.html`

## QJSON

JSON superset using QuickJS bignum syntax.

```javascript
{
  name: "thermocouple-7",       // unquoted keys
  offset: 0.003M,               // BigDecimal — exact base-10
  nonce: 42N,                   // BigInt
  calibration: 3.14159L,        // BigFloat — full precision
  readings: [22.5, 23.1,],      // trailing commas
  /* nested /* block */ comments */
}
```

Valid JSON is valid QJSON.  Parse accepts uppercase or lowercase
suffixes.  Serialize always uses uppercase.

The Prolog parser also accepts QJSON literals:
`price(btc, 67432.50M).` parses with the `M` suffix preserved
through the entire round-trip.

Native C implementation: 3.5M messages/sec, arena-allocated,
zero malloc per parse.

## Platform matrix

| Platform        | Engine        | Reactive | Persist | Run with |
|----------------|---------------|----------|---------|----------|
| CPython 3.7+    | `prolog.py`   | `reactive.py` | SQLite/PG | `python` |
| MicroPython     | `prolog.py`   | `reactive.py` | — | `micropython` |
| Node 18+        | `prolog-engine.js` | `reactive.js` | SQLite/PG | `node` |
| Bun             | `prolog-engine.js` | `reactive.js` | bun:sqlite | `bun` |
| QuickJS         | `prolog-engine.js` | `reactive.js` | SQLite | `qjs` |
| Browser         | `prolog-engine.js` | `reactive.js` | — | open `.html` |
| Browser + WASM  | `prolog-engine.js` | `reactive.js` | SQLite WASM | `createWasmDb` |
| C/C++ (embed)   | `wyatt.c`     | auto-bump | SQLite | link |
| C (standalone)  | `prolog_core.c` | — | — | link |
| ESP32/RP2040    | `wyatt.c` or `prolog.py` | yes | SQLite | — |

## Where Prolog wins over if/else

| Concern                  | Imperative           | Prolog               |
|-------------------------|----------------------|----------------------|
| Add a new sensor         | Touch every branch   | Add 1 clause         |
| Add a new fault type     | Modify the FSM       | Add 1 fact           |
| "Why is this blocked?"   | Write error reporting | Query existing rules |
| Motor stuck for 1 of 6   | Per-slot if/else     | Backtracking         |
| Runtime policy update    | Recompile, reflash   | assert/retract       |
| Test all state combos    | Write 100s of tests  | Inference handles it |
| Audit the decision logic | Read 2000 lines      | Read 40 clauses      |

## License

MIT
