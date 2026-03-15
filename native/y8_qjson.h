/* ============================================================
 * y8_qjson.h — y8 (Wyatt) native C API: QJSON + interval projection
 *
 * Arena-allocated: zero malloc per parse.  Reset between messages.
 *
 *   y8_arena a; y8_arena_init(&a, buf, sizeof(buf));
 *   y8_val *v = y8_parse(&a, text, len);
 *   char out[1024]; int n = y8_stringify(v, out, sizeof(out));
 *   y8_arena_reset(&a);  // ready for next message
 * ============================================================ */

#ifndef Y8_QJSON_H
#define Y8_QJSON_H

#include <stdint.h>
#include <stddef.h>

typedef enum {
    Y8_NULL, Y8_TRUE, Y8_FALSE,
    Y8_NUM,          /* double */
    Y8_BIGINT,       /* raw string, suffix N */
    Y8_BIGDEC,       /* raw string, suffix M */
    Y8_BIGFLOAT,     /* raw string, suffix L */
    Y8_BLOB,         /* binary data, 0j prefix (JS64 encoded) */
    Y8_STRING,
    Y8_ARRAY,
    Y8_OBJECT
} y8_type;

typedef struct y8_val y8_val;

typedef struct {
    const char *key;
    int         key_len;
    y8_val     *val;
} y8_kv;

struct y8_val {
    y8_type type;
    union {
        double  num;
        struct { const char *s; int len; } str;   /* string/bignum raw text */
        struct { const char *data; int len; } blob; /* binary blob data */
        struct { y8_val **items; int count; } arr;
        struct { y8_kv  *pairs; int count; } obj;
    };
};

/* ── Arena ───────────────────────────────────────────────── */

typedef struct {
    char   *buf;
    size_t  used;
    size_t  cap;
} y8_arena;

void  y8_arena_init(y8_arena *a, void *buf, size_t cap);
void  y8_arena_reset(y8_arena *a);
void *y8_arena_alloc(y8_arena *a, size_t size);

/* ── Parse ───────────────────────────────────────────────── */

/* Parse QJSON text.  Returns root value or NULL on error.
   All memory from arena — no malloc. */
y8_val *y8_parse(y8_arena *a, const char *text, int len);

/* ── Stringify ───────────────────────────────────────────── */

/* Write QJSON to buffer.  Returns bytes written (excluding NUL).
   BigInt→N, BigDecimal→M, BigFloat→L. */
int y8_stringify(const y8_val *v, char *buf, int cap);

/* ── Accessors ───────────────────────────────────────────── */

static inline y8_type  y8_type_of(const y8_val *v) { return v ? v->type : Y8_NULL; }
static inline double   y8_num(const y8_val *v)     { return v && v->type == Y8_NUM ? v->num : 0; }
static inline const char *y8_str(const y8_val *v)  { return v && v->type == Y8_STRING ? v->str.s : NULL; }
static inline int      y8_str_len(const y8_val *v) { return v && v->type == Y8_STRING ? v->str.len : 0; }
static inline int      y8_arr_len(const y8_val *v) { return v && v->type == Y8_ARRAY ? v->arr.count : 0; }
static inline y8_val  *y8_arr_get(const y8_val *v, int i) {
    return (v && v->type == Y8_ARRAY && i >= 0 && i < v->arr.count) ? v->arr.items[i] : NULL;
}
static inline int      y8_obj_len(const y8_val *v) { return v && v->type == Y8_OBJECT ? v->obj.count : 0; }
y8_val *y8_obj_get(const y8_val *v, const char *key);

/* ── Interval projection ────────────────────────────────── */

/* Project decimal string → [lo, hi] IEEE double interval.
   lo = largest double ≤ exact value  (ieee_double_round_down)
   hi = smallest double ≥ exact value (ieee_double_round_up)

   Exact doubles: lo == hi (point interval).
   Non-exact:     nextafter(lo, +inf) == hi (1-ULP bracket).
   Overflow:      lo = DBL_MAX, hi = +inf  (or symmetric for negative).

   With -DY8_USE_LIBBF: uses libbf (from QuickJS) for exact
   directed rounding.  Without: uses fesetround() + strtod().
   Both produce identical results. */
void y8_project(const char *raw, int len, double *lo, double *hi);

/* Project a parsed y8_val to its interval.
   Y8_NUM:     lo == hi == val->num (plain doubles are exact).
   Y8_BIGINT/Y8_BIGDEC/Y8_BIGFLOAT: directed rounding on raw string.
   Other types: lo = hi = 0. */
void y8_val_project(const y8_val *v, double *lo, double *hi);

/* Compare two decimal strings numerically.
   Returns -1 (a < b), 0 (a == b), 1 (a > b).
   With -DY8_USE_LIBBF: exact arbitrary-precision comparison.
   Without: string-based decimal comparison (no scientific notation). */
int y8_decimal_cmp(const char *a, int a_len, const char *b, int b_len);

/* Compare two projected values.  Returns -1, 0, or 1.
   Uses intervals for fast accept/reject, falls through to
   y8_decimal_cmp only in the overlap zone (~0.001%).

   All six operators: y8_cmp(...) <op> 0.

   For SQL WHERE clauses, expand inline for index usage:
     a < b  →  (a_hi < b_lo) OR ((a_lo < b_hi) AND cmp(a,b) < 0)
     a == b →  (a_hi >= b_lo AND b_hi >= a_lo) AND cmp(a,b) = 0
   See docs/qsql-intervals.md for all operators. */
int y8_cmp(double a_lo, double a_hi, const char *a_str, int a_len,
           double b_lo, double b_hi, const char *b_str, int b_len);

/* ── JS64 encode/decode ─────────────────────────────────── */

/* Decode JS64 characters to raw bytes.
   Input does NOT include the leading '$' (caller strips it / supplies body only).
   Internally prepends '$' (6 zero bits) for decoding.
   Returns number of decoded bytes, or -1 on error.
   Whitespace in input is skipped. */
int y8_js64_decode(const char *js64, int js64_len, char *out, int out_cap);

/* Encode raw bytes to JS64 characters.
   Output does NOT include the leading '$' (caller prepends '0j' for QJSON).
   Returns number of JS64 characters written, or -1 on error. */
int y8_js64_encode(const char *data, int data_len, char *out, int out_cap);

#endif
