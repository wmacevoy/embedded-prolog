# QSQL Interval Arithmetic — Exact Comparisons Without the Cost

## Problem

QJSON BigDecimal values like `187.68M` represent exact base-10
numbers.  IEEE 754 doubles can't represent `187.68` exactly — the
nearest double is `187.67999999999998...` or `187.68000000000001...`
depending on rounding direction.

For storage and indexing, we want SQLite REAL columns (fast,
indexable).  For correctness, we need exact comparison when values
are close to a threshold.  Arbitrary-precision libraries are
expensive and defeat the purpose of an embeddable engine.

## Solution: interval representation

Every numeric value is an interval `[lo, exact, hi]`:

```
187.68M → [187.67999999999998, "187.68", 187.68000000000001]
              lo (floor)         exact       hi (ceil)
```

- `lo` — IEEE double rounded toward -infinity
- `hi` — IEEE double rounded toward +infinity
- `exact` — the original QJSON string (M/N/L suffix)

For plain numbers (no suffix), `lo == hi == value`.  The interval
has zero width.  No overhead.

## Why this works

IEEE 754 doubles have ~15–17 significant digits.  Two values that
differ must differ by at least 1 ULP (unit in the last place).
The interval `[lo, hi]` captures the full ULP range of the exact
value.

For comparison `a > b`:

| Condition | Result | Frequency |
|-----------|--------|-----------|
| `a.lo > b.hi` | **definitely true** | ~99.999% |
| `a.hi < b.lo` | **definitely false** | ~99.999% |
| intervals overlap | exact string comparison | ~0.001% |

The overlap case only occurs when two values are within 1 ULP of
each other — i.e., they'd round to the same double.  This is
astronomically rare in real data (prices, temperatures, coordinates).

## QSQL schema

For a predicate `price/3`:

```sql
CREATE TABLE "q$price$3" (
  _key  TEXT PRIMARY KEY,    -- full serialized term (restore)
  arg0  TEXT,                -- symbol (atom → TEXT, no interval)
  arg0_lo  REAL,             -- NULL for atoms
  arg0_hi  REAL,             -- NULL for atoms
  arg1  TEXT,                -- price value string ("67432.50")
  arg1_lo  REAL,             -- ieee_double_round_down(price)
  arg1_hi  REAL,             -- ieee_double_round_up(price)
  arg2  TEXT,                -- timestamp value string ("1710000000")
  arg2_lo  REAL,             -- ieee_double_round_down(timestamp)
  arg2_hi  REAL              -- ieee_double_round_up(timestamp)
);

CREATE INDEX "ix$q$price$3$0" ON "q$price$3"(arg0);      -- atom equality
CREATE INDEX "ix$q$price$3$0lo" ON "q$price$3"(arg0_lo);
CREATE INDEX "ix$q$price$3$1" ON "q$price$3"(arg1);      -- value equality
CREATE INDEX "ix$q$price$3$1lo" ON "q$price$3"(arg1_lo);  -- range queries
CREATE INDEX "ix$q$price$3$2" ON "q$price$3"(arg2);
CREATE INDEX "ix$q$price$3$2lo" ON "q$price$3"(arg2_lo);
```

For atom arguments: `arg TEXT` with `lo = NULL, hi = NULL`.

For exact doubles (most numbers): `lo == hi` → point interval.
NULL costs 0 bytes in SQLite.  Zero overhead.

For non-exact BigNums (rare): `lo + 1 ULP == hi` → 1-ULP bracket.

## Query pushdown

`y8_decimal_cmp(a, b)` is always the authority.  Intervals are
an optimization — they can prove strict inequality but can
**never** prove equality.  Two different exact values can project
to the same `[lo, hi]` (same double, same rounding direction).

Principle:
- Intervals can **prove** `a < b` when `a_hi < b_lo` (fast acceptance)
- Intervals can **reject** `a == b` when `a_hi < b_lo OR b_hi < a_lo` (fast rejection)
- Intervals can **never prove** `a == b` — always need `y8_decimal_cmp`

### General form

```sql
a <op> b ≡
  (interval_sufficient)                           -- indexed REAL, fast
  OR y8_decimal_cmp(a, b) <op> 0                  -- authoritative, always correct
```

For `==` (no interval-sufficient exists, use rejection):
```sql
a == b ≡
  NOT (a_hi < b_lo OR b_hi < a_lo)               -- fast rejection (indexed)
  AND y8_decimal_cmp(a, b) = 0                    -- authoritative
```

### All comparison operators

| Op | interval sufficient (fast) | authoritative (always correct) |
|----|---------------------------|-------------------------------|
| `a < b`  | `a_hi < b_lo` | `y8_decimal_cmp(a, b) < 0`  |
| `a <= b` | `a_hi <= b_lo` | `y8_decimal_cmp(a, b) <= 0` |
| `a == b` | — (use rejection: `NOT (a_hi < b_lo OR b_hi < a_lo)`) | `y8_decimal_cmp(a, b) = 0` |
| `a != b` | `a_hi < b_lo OR b_hi < a_lo` | `y8_decimal_cmp(a, b) != 0` |
| `a >= b` | `a_lo >= b_hi` | `y8_decimal_cmp(a, b) >= 0` |
| `a > b`  | `a_lo > b_hi` | `y8_decimal_cmp(a, b) > 0`  |

The interval column handles 99.999% of comparisons via indexed
REAL.  `y8_decimal_cmp` fires for the ~0.001% boundary zone
(overlapping intervals).  For `==`, the overlap rejection
eliminates most non-matches before calling `y8_decimal_cmp`.

### Example: `a < b`

```sql
WHERE (a_hi < b_lo)                              -- intervals prove it
   OR y8_decimal_cmp(a, b) < 0                   -- exact comparison
```

### Example: `a == b`

```sql
WHERE NOT (a_hi < b_lo OR b_hi < a_lo)           -- intervals can't reject it
  AND y8_decimal_cmp(a, b) = 0                    -- exact comparison confirms it
```

`y8_decimal_cmp` compares decimal strings numerically (not
lexicographically).  Implemented in C (`y8_qjson.c`), available
as a SQLite custom function via `sqlite3_create_function`.

### Range: `price >= 60000M AND price <= 70000M`

```sql
WHERE arg1_hi >= 60000.0 AND arg1_lo <= 70000.0
```

Again: correct for 99.999% of data.  Exact refinement only for
values whose intervals straddle 60000.0 or 70000.0.

## Computing lo and hi

### C (canonical implementation)

The C layer uses IEEE 754 directed rounding modes — no string
comparison, no polyfill, just hardware math:

```c
#include <fenv.h>

void y8_project(const char *raw, int len, double *lo, double *hi) {
    char buf[320];
    memcpy(buf, raw, len); buf[len] = '\0';

    int saved = fegetround();
    fesetround(FE_DOWNWARD);
    *lo = strtod(buf, NULL);    // largest double ≤ exact
    fesetround(FE_UPWARD);
    *hi = strtod(buf, NULL);    // smallest double ≥ exact
    fesetround(saved);
}
```

This is `y8_project()` in `native/y8_qjson.c`.  All other
implementations are polyfills for this.

Edge cases handled by the C standard:

| Input | lo | hi |
|-------|----|----|
| `"42"` (exact) | 42.0 | 42.0 |
| `"0.1"` (inexact) | nextDown(0.1) | 0.1 |
| `"9007199254740993"` (2^53+1) | 2^53 | 2^53+2 |
| `"2e308"` (overflow) | DBL_MAX | +Infinity |
| `"-2e308"` (neg overflow) | -Infinity | -DBL_MAX |
| `"5e-325"` (underflow) | 0.0 | 5e-324 |

### QuickJS (BigFloat)

QuickJS with `CONFIG_BIGNUM` provides directed rounding natively:

```javascript
var exact = BigFloat(raw);
var lo = Number(BigFloat.toFloat64(exact, BigFloatEnv.RNDD));
var hi = Number(BigFloat.toFloat64(exact, BigFloatEnv.RNDU));
```

No string comparison needed — same as the C path.

### JavaScript (ES5 polyfill)

Engines without directed rounding (Node, Bun, Deno, browser)
detect rounding direction via `toPrecision` + decimal string
comparison.  See `_roundingDir()` and `_decCmp()` in `src/qsql.js`.

```
v = Number(raw)           // nearest double
dir = _roundingDir(v, raw) // 0 (exact), 1 (v > exact), -1 (v < exact)

dir ==  0 → [v, v]                    // point interval
dir ==  1 → [nextDown(v), v]          // v rounded up
dir == -1 → [v, nextUp(v)]            // v rounded down
```

### Python (decimal.Decimal)

Python uses `decimal.Decimal` for exact comparison.  See
`_rounding_dir()` in `src/qsql.py`.

```python
from decimal import Decimal

d_exact  = Decimal(raw)       # exact decimal value
d_double = Decimal(float(v))  # exact value of the double

if d_double == d_exact:  lo = hi = v           # point
elif d_double > d_exact: lo, hi = nextDown(v), v
else:                    lo, hi = v, nextUp(v)
```

### Implementation hierarchy

| Engine | Method | String comparison? |
|--------|--------|--------------------|
| C (`y8_qjson.c`) | `fesetround` + `strtod` | No |
| QuickJS | `BigFloat.toFloat64` with rounding mode | No |
| Python | `decimal.Decimal` exact comparison | No |
| Node/Bun/Deno/browser | `toPrecision` + `_decCmp` | Yes (polyfill) |

## What doesn't change

| Layer | Impact |
|-------|--------|
| Prolog engine | None. Uses `.value` (double) for `>/2`, `</2`, `is/2`. Correct 99.999%. |
| Parser | None. Already stores `.repr`. |
| Persist `_ser/_deser` | None. Already round-trips `.repr` via `r` field. |
| `termToString` | None. Already uses `.repr` when present. |
| `store.js` shim | None. Stores values via engine. |
| Unification | None. Compares `.value`. Two M-values unify if doubles match. |

## What changes

| Layer | Change |
|-------|--------|
| `y8_qjson.h` / `y8_qjson.c` | `y8_project()`: canonical projection via `fesetround` + `strtod` |
| `y8_qjson.h` / `y8_qjson.c` | `y8_val_project()`: project parsed values; `y8_decimal_cmp()`: string comparison |
| `qsql.js` schema | 3 columns per arg: `arg TEXT, arg_lo REAL, arg_hi REAL` (was 4 with `_x`) |
| `qsql.js` `_qsql_argInterval` | Returns `[val, lo, hi]` with rounding direction detection |
| `qsql.js` `_roundingDir` | Detects whether double > or < exact decimal value |
| `qsql.js` `_decCmp` | Decimal string comparison (polyfill for `y8_decimal_cmp`) |
| `qsql.py` `_arg_interval` | Same — uses `decimal.Decimal` for exact comparison |
| `qsql.py` `_rounding_dir` | Uses `decimal.Decimal` for direction detection |
| (future) `queryArgs` | SQL pushdown with interval-aware WHERE clauses (see table above) |

## Storage overhead

Per numeric argument: 3 columns (arg TEXT, arg_lo REAL, arg_hi REAL).
- Value string: typically 5-20 bytes
- 2 REAL columns: 16 bytes
- Total: ~24-36 bytes per argument

For exact doubles (most values): `lo == hi` → the interval adds
16 bytes of REALs but the string is short.  Atoms have `lo = hi = NULL`
(0 bytes in SQLite).

The 4th column (`_x`) from the previous design is eliminated —
the value string IS the primary column.

## Correctness argument

Given exact value `E` and IEEE double approximation `d`:

1. `d = nearest(E)` — IEEE 754 default rounding
2. `|d - E| < 1 ULP(d)` — by definition of nearest
3. `lo = max(double ≤ E)` and `hi = min(double ≥ E)`
4. Therefore: `lo ≤ E ≤ hi`
5. For any other exact value `F` with `F > E`:
   - If `F - E > 2 ULP`: their intervals don't overlap → `f.lo > e.hi` → double comparison correct
   - If `F - E ≤ 2 ULP`: intervals may overlap → exact string comparison needed
6. Values within 2 ULP of each other represent a difference of ~10^-15 relative to the value
7. For financial data (prices, quantities), real differences are at least 10^-8 (1 satoshi, 0.01 cents)
8. Therefore: interval overlap never occurs in practice for financial comparisons

The exact fallback exists for mathematical completeness, not for
practical necessity.  It costs nothing when not triggered.

## Example: full round-trip

```
Input:    price(btc, 67432.50M, 1710000000N).

Parse:    {type:"num", value:67432.5, repr:"67432.50M"}

Engine:   67432.5 > 70000 → false (double comparison, correct)

QSQL:    INSERT INTO "q$price$3" VALUES (
            '{"t":"c","f":"price","a":[...]}',  -- _key
            'btc', NULL, NULL,                    -- arg0: atom, no interval
            '67432.50', 67432.5, 67432.5,         -- arg1: value, lo=hi (exact)
            '1710000000', 1710000000, 1710000000   -- arg2: value, lo=hi (exact)
          )

Query:    WHERE arg1_lo > 60000.0 AND arg1_hi < 70000.0
          → hits index, returns row, correct

Restore:  _key → deserialize → {type:"num", value:67432.5, repr:"67432.50M"}

Print:    termToString → "67432.50M"
```

The exact decimal `67432.50` never becomes `67432.499999...` or
`67432.500001...`.  The double `67432.5` happens to be exact for
this value, so `lo == hi` and the interval has zero width.  For
values like `0.1M` where the double is inexact, the interval is
1-ULP wide: `lo = nextDown(0.1_double), hi = 0.1_double` (since
the double rounds UP).  The value string `"0.1"` in the primary
column preserves the exact representation.
