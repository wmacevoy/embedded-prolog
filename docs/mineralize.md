# fossilize vs mineralize — Two Modes of Hardening

## The problem

`fossilize()` is nuclear. After it fires, nothing changes — no
assert, no retract, only ephemeral. This is perfect for embedded
devices and parallelizable workers (vocations/dens in Strata),
but too blunt for long-running systems where some things must
change and some things must never change.

A BTC price monitoring system needs `price/3` to flow freely
while `threshold/4` and `react/0` are locked. A compliance
engine needs GDPR rules hardened while user data mutates. A
multiplayer game needs spell definitions locked while game
state evolves.

## Two concepts

### fossilize() — global freeze

Everything before the boundary is immutable. Everything after
is ephemeral-only. The engine becomes a pure decision function:
events in, decisions out.

```
fossilize()
  ↓
  ALL clauses frozen
  assert/retract → fail
  addClause → no-op
  ephemeral → still works
  retractFirst → ephemeral zone only
```

**Use case:** parallelizable workers. If rules can't change,
a thousand instances run the same logic against different data
with zero coordination. Fossilized dens in Strata.

### mineralize(Functor/Arity) — selective lock

Specific predicates become immutable. Everything else stays
fully dynamic. Multiple predicates can be mineralized
independently. Mineralization is one-way — you can't
un-mineralize.

```
mineralize(react/0)
mineralize(threshold/4)
mineralize(trusted_feed/1)
  ↓
  react, threshold, trusted_feed → immutable
  price/3, holding/2, reading/4 → fully mutable
  assert(price(...)) → works
  assert(threshold(...)) → FAILS
  retract(react) → FAILS
```

**Use case:** shared spaces. A town hall where the constitution
(core rules) is hardened but proposals, votes, and messages
flow freely. No graffiti on the concepts. Democracy on the data.

## How they compose

```
mineralize(react/0).         % lock specific rules
mineralize(threshold/4).     % lock specific facts
... system runs with mixed mutability ...
fossilize().                  % nuclear option: lock EVERYTHING
```

Mineralize is additive — each call locks one more predicate.
Fossilize is final — nothing changes after. You can mineralize
some predicates, run the system, then fossilize later if needed.
The reverse is not possible: fossilize cannot be undone, and
mineralized predicates cannot be un-mineralized.

## Implementation

### Engine changes

Add `engine.mineralized` — a plain object mapping
`"functor/arity"` strings to `true`.

```javascript
engine.mineralized = {};    // {} initially, grows monotonically
```

### mineralize(Pred) — JS

```javascript
function mineralize(engine, functor, arity) {
    engine.mineralized[functor + "/" + arity] = true;
}
```

One-way. No API to remove entries. The set only grows.

### Guard: addClause

```javascript
var origAddClause = engine.addClause;
engine.addClause = function(head, body) {
    var key = _predKey(head);
    if (key && engine.mineralized[key]) return;  // no-op
    origAddClause.call(engine, head, body);
};
```

### Guard: retractFirst

```javascript
var origRetractFirst = engine.retractFirst;
engine.retractFirst = function(head) {
    var key = _predKey(head);
    if (key && engine.mineralized[key]) return false;
    return origRetractFirst.call(engine, head);
};
```

### Guard: assert/1, retract/1, retractall/1 builtins

These builtins call `addClause` and `retractFirst` internally,
so the guards above catch them. But for safety, also wrap the
builtins to check before attempting:

```javascript
// assert/1: check before calling addClause
var origAssert = engine.builtins["assert/1"];
engine.builtins["assert/1"] = function(goal, rest, subst, ...) {
    var term = engine.deepWalk(goal.args[0], subst);
    var key = _predKey(term);
    if (key && engine.mineralized[key]) return; // fail
    origAssert(goal, rest, subst, ...);
};
```

### Guard: ephemeral/1

Ephemeral uses `engine.clauses.push()` and `engine.retractFirst()`
directly. After mineralize, the retractFirst guard catches it.
But the push bypasses addClause. Need to guard ephemeral too:

```javascript
var origEphemeral = engine.builtins["ephemeral/1"];
engine.builtins["ephemeral/1"] = function(goal, rest, subst, ...) {
    var term = engine.deepWalk(goal.args[0], subst);
    var key = _predKey(term);
    if (key && engine.mineralized[key]) return; // fail
    origEphemeral(goal, rest, subst, ...);
};
```

This means ephemeral signals can't be mineralized predicates.
That's correct: `ephemeral(threshold(...))` should fail if
threshold is mineralized.

### mineralize/1 builtin (Prolog-callable)

```prolog
mineralize(react/0).
mineralize(threshold/4).
```

Implemented as a builtin that parses `Pred/Arity`:

```javascript
engine.builtins["mineralize/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    if (term.type === "compound" && term.functor === "/" && term.args.length === 2) {
        var functor = term.args[0].name;
        var arity = term.args[1].value;
        engine.mineralized[functor + "/" + arity] = true;
    }
    engine.solve(rest, subst, counter, depth + 1, onSolution);
};
```

### fossilize interaction

After `fossilize()`, the engine replaces `addClause` and
`retractFirst` entirely. The mineralize guards become
irrelevant (fossilize is strictly stronger). Mineralized
predicates are included in the fossilized set — they were
already immutable.

### Python equivalent

Same logic. `engine.mineralized = {}` dict, same guards on
`add_clause`, `retract_first`, and builtins.

## Strata mapping

| Strata concept | Wyatt mechanism | Effect |
|----------------|-----------------|--------|
| Vocation (den) | `fossilize()` | Pure parallel worker. No coordination. |
| Town hall concept | `mineralize(concept/N)` | Graffiti-proof shared rule. Data flows. |
| Town hall data | Unmineralized predicates | Fully mutable. Proposals, votes, messages. |

A vocation IS a fossilized den. The rules are the parallelism
guarantee: if nothing can change, everything can run simultaneously.

A town hall has mineralized concepts. The constitution is crystal.
The legislature is fluid. Nobody rewrites what "vote" means, but
everyone can cast one.

## Security properties

| Property | fossilize | mineralize |
|----------|-----------|------------|
| Prevents rule injection | yes (all) | yes (selected) |
| Prevents fact injection | yes (all) | yes (selected) |
| Allows data mutation | no (ephemeral only) | yes (non-mineralized) |
| Reversible | no | no |
| Composable | terminal | additive |
| Parallelizable | fully | depends on data patterns |

## Examples

### Crypto sentinel with mineralized rules

```prolog
% Load rules and thresholds
threshold(btc, above, 70000M, sell_alert).
threshold(btc, below, 60000M, buy_alert).
react :- signal(_Src, price_update(Symbol, Price, Ts)),
         retractall(price(Symbol, _P, _T)),
         assert(price(Symbol, Price, Ts)).

% Lock the rules — data stays fluid
mineralize(threshold/4).
mineralize(react/0).
mineralize(trusted_feed/1).

% These still work:
assert(price(btc, 72000M, 1710000001N)).   % ← OK
retractall(price(btc, _P, _T)).             % ← OK

% These fail:
assert(threshold(btc, above, 0M, hack)).    % ← blocked
```

### Compliance engine with mineralized GDPR rules

```prolog
gdpr_compliant(User) :-
    consent(User, Purpose),
    retention_ok(User, Purpose).

mineralize(gdpr_compliant/1).
mineralize(retention_ok/2).

% Auditor verifies rules. System can't change them.
% But consent/2 facts still flow as users grant/revoke consent.
```
