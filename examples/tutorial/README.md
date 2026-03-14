# Tutorial — Learn Y@ step by step

Nine progressive examples that build a smart thermostat, teaching
one concept per file.  Each file is self-contained and runnable.

```
node examples/tutorial/01-facts.js     # or bun, qjs --module, deno run
node examples/tutorial/test.js         # 27 tests covering all 9 steps
```

## Steps

| # | File | Concept | What you learn |
|---|------|---------|----------------|
| 1 | `01-facts.js` | Facts and queries | `atom`, `compound`, `num`, `variable`, `addClause`, `query`, `queryFirst` |
| 2 | `02-rules.js` | Rules | `addClause(head, body)` — derive new knowledge from existing facts |
| 3 | `03-arithmetic.js` | Arithmetic | `is/2`, `>`, `<`, `>=`, `=<` — computed values and comparisons |
| 4 | `04-lists.js` | Lists | `PrologEngine.list`, `member/2`, `listToArray` |
| 5 | `05-dynamic.js` | Dynamic state | `assert/1`, `retract/1`, `retractall/1` — runtime fact mutation |
| 6 | `06-negation-findall.js` | Negation and aggregation | `not/1`, `findall/3` — "which rooms are NOT comfortable?" |
| 7 | `07-parser.js` | Text parser | `loadString` — write Prolog syntax instead of JS term constructors |
| 8 | `08-reactive.js` | Reactive queries | `createReactiveEngine`, `createQuery`, `onUpdate`, `bump` |
| 9 | `09-ephemeral.js` | Ephemeral/react signals | `ephemeral/1`, `handle_signal/2`, `react` rules |

## The thermostat theme

The examples use a smart thermostat to keep things concrete:

- **Steps 1-3**: Rooms, temperatures, targets, comfort rules
- **Steps 4-6**: Heating schedules, dynamic sensor updates, aggregation
- **Step 7**: Rewrite everything in clean Prolog syntax
- **Step 8**: Live queries that auto-update when temperatures change
- **Step 9**: Accept/drop sensor signals with Prolog policy rules

## Where to go next

After the tutorial, explore the domain examples:

- **[Vending machine](../vending/)** — 12 sensors, fault detection, credit handling (Python + JS)
- **[IoT router](../router/)** — Battery-aware failover routing (Python)
- **[Margin trading](../margin/)** — P&L triggers with BigDecimal (JS)
- **[NNG mesh](../nng-mesh/)** — Distributed sensor mesh with signal policy (JS)
- **[Greenhouse](../greenhouse/)** — Multi-runtime IoT system: C + JS + Python over UDP (Docker)
