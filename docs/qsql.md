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

## Persistence via react rules

Persistence is not a built-in layer — it's two react rules
and native hooks.  See `docs/y8-prolog.md`.

```prolog
react(assert(F))  :- native(db_insert(F), _Ok).
react(retract(F)) :- native(db_remove(F), _Ok).
```

| Prolog | SQLite (via native hook) |
|--------|--------------------------|
| `assert(F)` | `INSERT INTO q$... VALUES (...)` |
| `retract(F)` | `DELETE FROM q$... WHERE _key = ?` |
| `ephemeral(F)` | no SQL — never touches the database |

- **Persistent facts** = database state.  `assert` triggers
  `react(assert(F))` which calls `native(db_insert(F), _)`.
  Survives restart.
- **Ephemeral events** = transient signals.  `ephemeral(Event)`
  triggers `react(Event)` but never enters the database.
  Zero I/O.

SQLite WAL mode: readers never block writers.

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
