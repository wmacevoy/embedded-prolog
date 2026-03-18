# y8-prolog — Ephemeral reactive Prolog

y8-prolog is a Prolog dialect designed for embedded reactive systems.
Rules are the program.  Facts are the state.  Signals flow
through, trigger reactions, and vanish.  Predicates can be
selectively (mineralize) or globally (fossilize) frozen for
security and parallelism.

The engine has three primitives beyond standard Prolog:
**ephemeral**, **react**, and **native**.  Everything else —
persistence, tracing, metrics, I/O — is wiring.

## Reactivity

y8-prolog is reactive.  Every mutation and every event
triggers `react` rules automatically.

### Three triggers

```prolog
assert(Fact)      → triggers react(assert(Fact))
retract(Fact)     → triggers react(retract(Fact))
ephemeral(Event)  → triggers react(Event)
```

`react` rules are ordinary Prolog clauses.  The engine finds
all matching `react(...)` clauses and solves them.  Reactions
can mutate state, emit events, send messages, and call native
tools.

### react rules

```prolog
% Persist every mutation (just two rules)
react(assert(F))  :- native(db_insert, F).
react(retract(F)) :- native(db_remove, F).

% Trace every mutation
react(assert(F))  :- native(log, assert, F).
react(retract(F)) :- native(log, retract, F).

% Process signals
react(signal(From, reading(From, Type, Val, Ts))) :-
    trusted(From),
    retractall(reading(From, Type, _V, _T)),
    assert(reading(From, Type, Val, Ts)).

% Threshold alerting
react(new_reading(From, Type, Val, _Ts)) :-
    threshold(Type, above, Limit, Alert),
    Val > Limit,
    send(alerts, Alert).
```

Multiple react rules for the same pattern all fire.  Different
concerns (persist, trace, process, alert) are separate rules,
separately maintainable, separately freezable.

### Cascading

Mutations inside react rules trigger further reactions:

```
ephemeral(signal(sensor1, reading(sensor1, temp, 35, ts)))
  → react(signal(...)) fires
    → retractall(reading(sensor1, temp, _V, _T))
      → react(retract(reading(...))) fires → persist, trace
    → assert(reading(sensor1, temp, 35, ts))
      → react(assert(reading(...))) fires → persist, trace
    → ephemeral(new_reading(sensor1, temp, 35, ts))
      → react(new_reading(...)) fires → threshold check → send
  → all sends collected
  → signal was never in the database
```

Cascading is intentional.  Each react rule is simple.  The
chain of reactions composes complex behavior from small pieces.
Depth limits prevent runaway.

## Three primitives

### ephemeral(Event)

A transient event.  Never enters the clause database.  Cannot
be queried.  Cannot be retracted.  Triggers `react(Event)`,
then vanishes.

```prolog
ephemeral(signal(sensor1, reading(sensor1, temp, 35, ts))).
```

Ephemeral is hardened: the react chain completes or rolls
back atomically.  This enables:

- **Fossilized engines**: ephemeral doesn't mutate, so frozen
  engines can still receive and process signals.
- **ACID-like behavior**: the event and its reactions are
  an atomic unit.

### send(Target, Message)

Captures an outgoing message.  Doesn't transmit — appends to
an internal list.  The application collects sends after the
query completes and decides what to do (push to WebSocket,
write to queue, log, etc.).

```prolog
react(new_reading(_From, Type, Val, _Ts)) :-
    threshold(Type, above, Limit, Alert),
    Val > Limit,
    send(alerts, Alert).
```

Prolog rules never touch I/O directly.  `send` is the
boundary between logic and the outside world.

### native(Name, Args...)

Calls an external tool registered by the host language.
The engine doesn't know what the tool does — it's a black
box.

```prolog
react(assert(F))  :- native(db_insert, F).
react(retract(F)) :- native(db_remove, F).
```

The host registers tools:

```javascript
// JavaScript
engine.native("db_insert", function(fact) { adapter.insert(fact); });
engine.native("db_remove", function(fact) { adapter.remove(fact); });
engine.native("sha256", function(data) { return crypto.hash("sha256", data); });
```

```python
# Python
engine.native("db_insert", lambda fact: adapter.insert(fact))
engine.native("sha256", lambda data: hashlib.sha256(data).digest())
```

```c
// C
y8_native(engine, "db_insert", my_insert_handler);
y8_native(engine, "sha256", my_sha256_handler);
```

Native tools are how y8-prolog connects to the world:
persistence, crypto, HTTP, file I/O, GPIO, anything.  The
engine is pure logic; the host provides the tools.

## Facts, rules, events

Three categories in the clause database:

| Category | Created by | In database? | Queryable? | Triggers react? |
|----------|-----------|-------------|-----------|-----------------|
| **Persistent fact** | `assert` | yes | yes | `react(assert(F))` |
| **Rule** | `loadString` | yes | via inference | no |
| **Ephemeral event** | `ephemeral` | no | no | `react(Event)` |

`retract` removes persistent facts and triggers
`react(retract(F))`.  Rules are loaded once and optionally
frozen via `mineralize`/`fossilize`.

## Freezing: fossilize and mineralize

### fossilize — global freeze

```prolog
fossilize.
```

All clauses become immutable.  `assert`, `retract`, `addClause`
fail.  Ephemeral still works — it doesn't mutate the database.
The engine becomes a pure function: events in, sends out.

**Use case:** parallel workers.  A thousand instances run the
same frozen rules against different signals with zero
coordination.

### mineralize — selective freeze

```prolog
mineralize(react/1).
mineralize(trusted/1).
mineralize(threshold/4).
```

Specific predicates become immutable.  Everything else stays
dynamic.  One-way — you can't un-mineralize.

**Use case:** long-running systems.  Lock the rules and access
control.  Let data flow freely.

### Security model

```
┌──────────────────────────────────────────┐
│  Fossilized: everything frozen           │
│  ┌───────────────────────────────────┐   │
│  │  Mineralized: selected frozen     │   │
│  │  ┌────────────────────────────┐   │   │
│  │  │  Dynamic: assert/retract   │   │   │
│  │  └────────────────────────────┘   │   │
│  └───────────────────────────────────┘   │
│  Ephemeral: always works (no mutation)   │
└──────────────────────────────────────────┘
```

## Wiring

Nothing is built in except inference, ephemeral, react, send,
and native.  Everything else is wiring:

```prolog
% Persistence — two react rules + native hooks
react(assert(F))  :- native(db_insert, F).
react(retract(F)) :- native(db_remove, F).

% Tracing — react rules
react(assert(F))  :- native(log, assert, F).
react(retract(F)) :- native(log, retract, F).

% Metrics — react + send
react(assert(F))  :- send(metrics, asserted(F)).

% Signal processing — react + ephemeral chaining
react(signal(From, Reading)) :-
    trusted(From),
    retractall(reading(From, _V, _T)),
    assert(reading(From, Reading)),
    ephemeral(new_reading(From, Reading)).

% Threshold alerting — react + send
react(new_reading(_From, reading(_Src, Type, Val, _Ts))) :-
    threshold(Type, above, Limit, Alert),
    Val > Limit,
    send(alerts, Alert).
```

Different concerns, different rules.  Add persistence by adding
two rules.  Add tracing by adding two rules.  Remove them by
removing the rules.  No framework, no plugin API, no callbacks
to register.

## CPS execution model

```
solve(goals, subst, counter, depth, onSolution)
```

Continuation-passing style.  No generators.  Backtracking is
calling the next continuation.

- `goals` — remaining goals to prove
- `subst` — variable bindings (substitution map)
- `counter` — fresh variable counter
- `depth` — recursion depth (for limits)
- `onSolution` — callback on success

## QJSON objects as terms

QJSON object literals are first-class terms in y8-prolog.
No ceremony — the data IS the term:

```prolog
react(on_login({user: Name, pass: Word})) :-
    native(check_password, Name, Word, Ok),
    Ok == true,
    send(session, logged_in(Name)).

react(signal({from: From, type: Type, value: Val})) :-
    trusted(From),
    Val > threshold(Type),
    send(alerts, {type: Type, value: Val, from: From}).
```

### Object unification

Objects unify by key intersection.  For each key that appears
in both objects, the values must unify.  Keys present in only
one object are unconstrained — the pattern picks the fields
it cares about:

```prolog
% {user: Name} unifies with {user: "alice", age: 30, role: "admin"}
% → Name = "alice"  (age and role ignored)

% {user: "alice"} unifies with {user: "alice", age: 30}
% → succeeds  (alice = alice, age ignored)

% {user: "alice"} fails against {user: "bob"}
% → fails  (alice ≠ bob)
```

This is symmetric: `unify(A, B) == unify(B, A)`.
Keys in both → values must match.  Keys in only one → pass.

### Object terms in the engine

```
{user: "alice", age: 30}
```

becomes:

```javascript
// JS
{ type: "object", pairs: [
    { key: "user", value: { type: "atom", name: "alice" } },
    { key: "age",  value: { type: "num", value: 30 } }
]}
```

## Term representation

| Language | Atom | Compound | Number | Variable | Object |
|----------|------|----------|--------|----------|--------|
| JS | `{type:"atom", name}` | `{type:"compound", functor, args}` | `{type:"num", value, repr?}` | `{type:"var", name}` | `{type:"object", pairs:[{key,value}]}` |
| Python | `("atom", name)` | `("compound", functor, (args,))` | `("num", value, repr?)` | `("var", name)` | `("object", ((key,value),...))` |
| C | 32-bit tagged (tag 31:30, payload 29:0) | | | | |

The optional `repr` field preserves QJSON notation
(`"67432.50M"`, `"42N"`) through the full round-trip.

## Builtins

| Builtin | Purpose |
|---------|---------|
| `assert/1` | Add fact, trigger `react(assert(F))` |
| `retract/1` | Remove first match, trigger `react(retract(F))` |
| `retractall/1` | Remove all matches, trigger `react(retract(F))` each |
| `ephemeral/1` | Transient event, trigger `react(Event)` |
| `send/2` | Capture outgoing message |
| `native/N` | Call external tool |
| `mineralize/1` | Freeze a predicate |
| `fossilize/0` | Freeze everything |
| `findall/3` | Collect all solutions |
| `not/1` | Negation as failure |
| `is/2` | Arithmetic evaluation |
| `>/2`, `</2`, `>=/2`, `=</2` | Arithmetic comparison |
| `==/2`, `\==/2` | Term equality/inequality |
| `=/2` | Unification |
| `call/1` | Meta-call |
| `member/2` | List membership |
| `append/3` | List append |
| `length/2` | List length |

## Implementations

| Language | Engine | Lines |
|----------|--------|-------|
| JavaScript | `prolog-engine.js` | ~300 |
| Python | `prolog.py` | ~300 |
| C (embed) | `y8.c` (QuickJS + SQLite) | ~400 |

The engine is the same ~300 lines everywhere.  Native tools
differ per host.  Persistence is react rules, not a built-in
layer.

## Example: complete IoT system

```prolog
% ── Native tools (registered by host) ──────────────
% native(db_insert, F)    — SQLite persist
% native(db_remove, F)    — SQLite persist
% native(log, Op, F)      — structured logging
% native(sha256, Data, H) — crypto

% ── Persistence (two rules) ────────────────────────
react(assert(F))  :- native(db_insert, F).
react(retract(F)) :- native(db_remove, F).

% ── Access control ─────────────────────────────────
trusted(sensor1).
trusted(sensor2).

% ── Thresholds ─────────────────────────────────────
threshold(temperature, above, 30, overheat_alert).
threshold(humidity, above, 80, moisture_alert).

% ── Signal processing ──────────────────────────────
react(signal(From, reading(From, Type, Val, Ts))) :-
    trusted(From),
    retractall(reading(From, Type, _V, _T)),
    assert(reading(From, Type, Val, Ts)),
    ephemeral(new_reading(From, Type, Val, Ts)).

react(signal(From, _Reading)) :-
    \== trusted(From),
    send(security, untrusted_signal(From)).

% ── Threshold alerting ─────────────────────────────
react(new_reading(_From, Type, Val, _Ts)) :-
    threshold(Type, above, Limit, Alert),
    Val > Limit,
    send(alerts, Alert).

% ── Freeze rules, let data flow ────────────────────
mineralize(react/1).
mineralize(trusted/1).
mineralize(threshold/4).
```

```javascript
// Application: receive signal, collect sends
var sends = engine.ephemeral(
    compound("signal", [atom("sensor1"),
        compound("reading", [atom("sensor1"),
            atom("temperature"), num(35), num(1710000000)])])
);
// sends = [{target: "alerts", fact: overheat_alert}]
// reading persisted via react(assert(...)) → native(db_insert, ...)
// signal was never in the database
```
