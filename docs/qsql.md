# QSQL — Per-predicate typed SQLite for Prolog

QSQL bridges Prolog terms to SQLite tables with typed columns
and interval arithmetic.  Each predicate gets its own table.
Arguments become indexed columns.  Exact QJSON numerics survive
the round-trip through IEEE 754 doubles via `[lo, str, hi]`
projection.

## From Prolog terms to SQL rows

```prolog
price(btc, 67432.50M, 1710000000N).
```

becomes:

```sql
INSERT INTO "q$price$3" VALUES (
  '{"t":"c","f":"price","a":[...]}',      -- _key (full term, for restore)
  'btc',    NULL,       NULL,              -- arg0: atom
  '67432.50', 67432.5,    67432.5,         -- arg1: [lo, str, hi]
  '1710000000', 1710000000, 1710000000     -- arg2: [lo, str, hi]
);
```

The `_key` column holds the complete serialized term — QSQL
never needs to reconstruct a term from its columns.  The typed
columns exist purely for **indexed query pushdown**.

## Schema

Table name: `q$<functor>$<arity>`.

Per argument: 3 columns.

| Column | Type | Content |
|--------|------|---------|
| `arg{i}` | TEXT | value as string (atom name, exact numeric repr, blob) |
| `arg{i}_lo` | REAL | `ieee_double_round_down(exact_value)`, NULL for atoms |
| `arg{i}_hi` | REAL | `ieee_double_round_up(exact_value)`, NULL for atoms |

Indexes on `arg{i}` (equality) and `arg{i}_lo` (range).

```sql
CREATE TABLE "q$price$3" (
  _key     TEXT PRIMARY KEY,
  arg0     TEXT,  arg0_lo REAL, arg0_hi REAL,
  arg1     TEXT,  arg1_lo REAL, arg1_hi REAL,
  arg2     TEXT,  arg2_lo REAL, arg2_hi REAL
);
```

## Projection: `[lo, str, hi]`

Every numeric argument projects to three values:

- **str** — the exact string representation (`"67432.50"`,
  `"0.1"`, `"9007199254740993"`).  Always authoritative.
- **lo** — largest IEEE double ≤ exact value.
- **hi** — smallest IEEE double ≥ exact value.

| Value | lo | str | hi |
|-------|----|-----|----|
| `42` (exact double) | 42.0 | `"42"` | 42.0 |
| `67432.50M` (exact) | 67432.5 | `"67432.50"` | 67432.5 |
| `0.1M` (inexact) | round_down(0.1) | `"0.1"` | round_up(0.1) |
| `9007199254740993N` | 2^53 | `"9007199254740993"` | 2^53+2 |
| `2e308M` (overflow) | DBL_MAX | `"2e308"` | +Infinity |
| atom `btc` | NULL | `"btc"` | NULL |

Canonical implementation: `y8_project()` in C using
`fesetround` + `strtod`.  See `docs/qjson.md` for the type
system and `docs/qsql-intervals.md` for the full interval
arithmetic.

## Comparison: `y8_cmp`

```c
int y8_cmp(a_lo, a_hi, a_str, a_len, b_lo, b_hi, b_str, b_len) {
    if (a_hi < b_lo) return -1;                  // intervals prove a < b
    if (a_lo > b_hi) return  1;                  // intervals prove a > b
    if (a_lo == a_hi && b_lo == b_hi) return 0;  // both exact, same double
    return y8_decimal_cmp(a_str, a_len, b_str, b_len);
}
```

All six operators: `y8_cmp(...) <op> 0`.

For SQL WHERE clauses, expand inline for index usage:

| Op | SQL expansion |
|----|---------------|
| `a < b`  | `(a_hi < b_lo) OR ((a_lo < b_hi) AND cmp(a,b) < 0)` |
| `a <= b` | `(a_hi <= b_lo) OR ((a_lo <= b_hi) AND cmp(a,b) <= 0)` |
| `a > b`  | `(a_lo > b_hi) OR ((a_hi > b_lo) AND cmp(a,b) > 0)` |
| `a >= b` | `(a_lo >= b_hi) OR ((a_hi >= b_lo) AND cmp(a,b) >= 0)` |
| `a == b` | `(a_hi >= b_lo AND b_hi >= a_lo) AND cmp(a,b) = 0` |
| `a != b` | `(a_hi < b_lo OR b_hi < a_lo) OR cmp(a,b) != 0` |

The interval branches use indexed REAL columns (99.999%).
`y8_decimal_cmp` only fires in the overlap zone (~0.001%).

## Ephemeral ↔ Transaction

Prolog's `ephemeral/1` scopes assertion lifetime to a single
query.  In QSQL, this maps to SQLite transaction semantics.

### The pattern

```prolog
handle_signal(From, Fact) :-
    ephemeral(signal(From, Fact)),
    react.
```

`ephemeral(Goal)` asserts Goal, runs the continuation, then
retracts Goal — regardless of success or failure.  The fact
exists only for the duration of the query.

### How it maps to SQLite

| Prolog | SQLite |
|--------|--------|
| `assert(F)` | `INSERT INTO q$... VALUES (...)` |
| `retract(F)` | `DELETE FROM q$... WHERE _key = ?` |
| `ephemeral(F)` | INSERT → query → DELETE (no commit) |
| `retractall(F/A)` | `DELETE FROM q$... WHERE ...` |

Ephemeral facts are **not persisted**.  The persist layer
intercepts `assert`/`retract` and mirrors them to SQLite,
but ephemeral facts live only in the in-memory clause
database.  They never touch disk.

This is the right semantics:

- **Persistent facts** = the database state.  Survives restart.
  `assert(price(btc, 67432.50M))` → INSERT + commit.
- **Ephemeral facts** = signals, events, transient state.
  `ephemeral(signal(sensor1, reading(22.5)))` → in-memory
  only.  Gone after the query.  No I/O.

### Transaction boundaries

```
assert(F)      →  INSERT (auto-commit via WAL)
retractall(F)  →  DELETE (auto-commit)
ephemeral(F)   →  no SQL at all
```

The persist adapter's `commit()` is called at natural
boundaries (end of `queryFirst`, end of batch).  SQLite WAL
mode means readers never block writers.

### Why this works

Ephemeral facts are the Prolog equivalent of local variables
in a transaction.  They carry information through a chain of
rules (`signal → react → send`) without polluting the
persistent database.  The `queryWithSends` pattern collects
outgoing messages from an ephemeral signal without any
database writes:

```javascript
var sends = engine.queryWithSends(
    compound("handle_signal", [atom("sensor1"), reading])
);
// sends = [{to: "dashboard", msg: reading(...)}]
// No database touched.  Signal already gone.
```

This is zero-cost message passing through the rule engine.

## Persist adapter interface

Six methods.  Any SQLite-compatible backend (better-sqlite3,
WASM SQLite, SQLCipher, PostgreSQL) implements these:

```
setup()                          -- CREATE TABLE IF NOT EXISTS
insert(key, functor, arity)      -- INSERT into per-predicate table
remove(key)                      -- DELETE by _key
all(predicates?)                 -- SELECT _key for restore
commit()                         -- flush to disk
close()                          -- release resources
```

The adapter never parses terms — it receives the serialized
`_key` string and extracts typed columns via `_qsql_argInterval`.
Restoration is just `addClause(deserialize(_key))`.

## Full round-trip

```
1. Prolog:   assert(price(btc, 67432.50M, 1710000000N))
2. Persist:  serialize term → _key JSON string
3. QSQL:    extract args → project [lo, str, hi] per arg
4. SQLite:   INSERT INTO q$price$3 (typed columns + _key)
5. Restart:  SELECT _key FROM q$price$3
6. Restore:  deserialize _key → addClause(term)
7. Query:    price(X, Y, Z) → results with repr preserved
8. Print:    67432.50M  (not 67432.499999... or 67432.500001...)
```

The exact QJSON representation survives the entire cycle.
SQLite stores the doubles for fast indexed queries.  The
string column preserves what the user actually wrote.
