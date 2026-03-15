/* ============================================================
 * test_y8_qjson.c — Tests + benchmarks for native C Y8
 *
 * gcc -O2 -frounding-math -o test_y8 y8.c test_y8_qjson.c -lm && ./test_y8
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <float.h>
#include "y8_qjson.h"

static int pass = 0, fail = 0;

#define TEST(name, cond) do { \
    if (cond) { pass++; printf("  ok  %s\n", name); } \
    else { fail++; printf("  FAIL %s  [line %d]\n", name, __LINE__); } \
} while(0)

/* ── Correctness tests ───────────────────────────────────── */

static char arena_buf[65536];

static void test_parse_basic(void) {
    printf("=== Parse basics ===\n");
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));

    y8_val *v = y8_parse(&a, "42", 2);
    TEST("parse integer", v && v->type == Y8_NUM && v->num == 42);

    y8_arena_reset(&a);
    v = y8_parse(&a, "-3.14", 5);
    TEST("parse float", v && v->type == Y8_NUM && v->num < -3.13 && v->num > -3.15);

    y8_arena_reset(&a);
    v = y8_parse(&a, "\"hello\"", 7);
    TEST("parse string", v && v->type == Y8_STRING && strcmp(v->str.s, "hello") == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "true", 4);
    TEST("parse true", v && v->type == Y8_TRUE);

    y8_arena_reset(&a);
    v = y8_parse(&a, "false", 5);
    TEST("parse false", v && v->type == Y8_FALSE);

    y8_arena_reset(&a);
    v = y8_parse(&a, "null", 4);
    TEST("parse null", v && v->type == Y8_NULL);
}

static void test_parse_compound(void) {
    printf("\n=== Parse compound ===\n");
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));

    y8_val *v = y8_parse(&a, "[1,2,3]", 7);
    TEST("parse array", v && v->type == Y8_ARRAY && v->arr.count == 3);
    TEST("array[0]", y8_arr_get(v, 0)->num == 1);
    TEST("array[2]", y8_arr_get(v, 2)->num == 3);

    y8_arena_reset(&a);
    v = y8_parse(&a, "{\"a\":1,\"b\":2}", 13);
    TEST("parse object", v && v->type == Y8_OBJECT && v->obj.count == 2);
    TEST("obj.a", y8_obj_get(v, "a") && y8_obj_get(v, "a")->num == 1);
    TEST("obj.b", y8_obj_get(v, "b") && y8_obj_get(v, "b")->num == 2);
}

static void test_parse_bignum(void) {
    printf("\n=== Parse bignums ===\n");
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));

    y8_val *v = y8_parse(&a, "42N", 3);
    TEST("BigInt N", v && v->type == Y8_BIGINT && strcmp(v->str.s, "42") == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "42n", 3);
    TEST("BigInt n (lc)", v && v->type == Y8_BIGINT);

    y8_arena_reset(&a);
    v = y8_parse(&a, "3.14M", 5);
    TEST("BigDecimal M", v && v->type == Y8_BIGDEC && strcmp(v->str.s, "3.14") == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "3.14m", 5);
    TEST("BigDecimal m (lc)", v && v->type == Y8_BIGDEC);

    y8_arena_reset(&a);
    v = y8_parse(&a, "3.14L", 5);
    TEST("BigFloat L", v && v->type == Y8_BIGFLOAT && strcmp(v->str.s, "3.14") == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "3.14l", 5);
    TEST("BigFloat l (lc)", v && v->type == Y8_BIGFLOAT);
}

static void test_parse_comments(void) {
    printf("\n=== Parse comments ===\n");
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));

    const char *s = "// line comment\n42";
    y8_val *v = y8_parse(&a, s, strlen(s));
    TEST("line comment", v && v->type == Y8_NUM && v->num == 42);

    y8_arena_reset(&a);
    s = "/* block */ 42";
    v = y8_parse(&a, s, strlen(s));
    TEST("block comment", v && v->type == Y8_NUM && v->num == 42);

    y8_arena_reset(&a);
    s = "/* outer /* inner */ still */ 42";
    v = y8_parse(&a, s, strlen(s));
    TEST("nested block comment", v && v->type == Y8_NUM && v->num == 42);
}

static void test_parse_human(void) {
    printf("\n=== Parse human-friendly ===\n");
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));

    const char *s = "[1, 2, 3,]";
    y8_val *v = y8_parse(&a, s, strlen(s));
    TEST("trailing comma array", v && v->type == Y8_ARRAY && v->arr.count == 3);

    y8_arena_reset(&a);
    s = "{\"a\": 1, \"b\": 2,}";
    v = y8_parse(&a, s, strlen(s));
    TEST("trailing comma object", v && v->type == Y8_OBJECT && v->obj.count == 2);

    y8_arena_reset(&a);
    s = "{name: \"alice\", age: 30}";
    v = y8_parse(&a, s, strlen(s));
    TEST("unquoted keys", v && v->type == Y8_OBJECT && v->obj.count == 2);
    TEST("unquoted key value", y8_obj_get(v, "name") && strcmp(y8_str(y8_obj_get(v, "name")), "alice") == 0);
}

static void test_stringify(void) {
    printf("\n=== Stringify ===\n");
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));
    char out[1024];

    /* Round-trip: parse then stringify */
    const char *s = "{\"t\":\"c\",\"f\":\"temp\",\"a\":[{\"t\":\"a\",\"n\":\"kitchen\"},{\"t\":\"n\",\"v\":22}]}";
    y8_val *v = y8_parse(&a, s, strlen(s));
    TEST("parse term json", v != NULL);
    int n = y8_stringify(v, out, sizeof(out));
    TEST("stringify term", n > 0 && strcmp(out, s) == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "42N", 3);
    n = y8_stringify(v, out, sizeof(out));
    TEST("stringify BigInt → N", strcmp(out, "42N") == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "3.14M", 5);
    n = y8_stringify(v, out, sizeof(out));
    TEST("stringify BigDec → M", strcmp(out, "3.14M") == 0);

    y8_arena_reset(&a);
    v = y8_parse(&a, "3.14L", 5);
    n = y8_stringify(v, out, sizeof(out));
    TEST("stringify BigFloat → L", strcmp(out, "3.14L") == 0);
}

/* ── Projection tests ────────────────────────────────────── */

static void test_project(void) {
    printf("\n=== Projection (fesetround + strtod) ===\n");
    double lo, hi;

    /* Exact integer */
    y8_project("42", 2, &lo, &hi);
    TEST("42 exact", lo == 42.0 && hi == 42.0);

    /* Exact decimal */
    y8_project("67432.50", 8, &lo, &hi);
    TEST("67432.50 exact", lo == 67432.5 && hi == 67432.5);

    /* Non-exact: 0.1 (1-ULP bracket) */
    y8_project("0.1", 3, &lo, &hi);
    TEST("0.1 bracketed", lo < hi && lo <= 0.1 && hi >= 0.1);
    TEST("0.1 tight (1-ULP)", nextafter(lo, INFINITY) == hi);

    /* Non-exact: 0.3 (rounds down, double < exact) */
    y8_project("0.3", 3, &lo, &hi);
    TEST("0.3 bracketed", lo < hi);
    TEST("0.3 tight (1-ULP)", nextafter(lo, INFINITY) == hi);

    /* Large exact: 1e21 = 5^21 * 2^21, 5^21 < 2^53 */
    y8_project("1000000000000000000000", 22, &lo, &hi);
    TEST("1e21 exact", lo == hi && lo == 1e21);

    /* Large non-exact: 2^53 + 1 */
    y8_project("9007199254740993", 16, &lo, &hi);
    TEST("2^53+1 not exact", lo < hi);
    TEST("2^53+1 lo = 2^53", lo == 9007199254740992.0);
    TEST("2^53+1 hi = 2^53+2", hi == 9007199254740994.0);

    /* Very large non-exact: 1e25 (5^25 > 2^53) */
    y8_project("10000000000000000000000000", 25, &lo, &hi);
    TEST("1e25 not exact", lo < hi);
    TEST("1e25 tight (1-ULP)", nextafter(lo, INFINITY) == hi);

    /* Overflow: 2e308 > DBL_MAX */
    y8_project("2e308", 5, &lo, &hi);
    TEST("overflow lo = DBL_MAX", lo == DBL_MAX);
    TEST("overflow hi = +inf", hi == INFINITY);

    /* Negative overflow */
    y8_project("-2e308", 6, &lo, &hi);
    TEST("neg overflow lo = -inf", lo == -INFINITY);
    TEST("neg overflow hi = -DBL_MAX", hi == -DBL_MAX);

    /* Underflow: 5e-325 < smallest subnormal */
    y8_project("5e-325", 6, &lo, &hi);
    TEST("underflow lo = 0", lo == 0.0);
    TEST("underflow hi > 0", hi > 0.0 && hi <= 5e-324);

    /* Zero */
    y8_project("0", 1, &lo, &hi);
    TEST("zero exact", lo == 0.0 && hi == 0.0);

    /* Negative non-exact */
    y8_project("-0.1", 4, &lo, &hi);
    TEST("-0.1 bracketed", lo < hi && lo < 0 && hi < 0);
    TEST("-0.1 tight (1-ULP)", nextafter(lo, INFINITY) == hi);

    /* val_project: Y8_NUM → point interval */
    y8_arena a; y8_arena_init(&a, arena_buf, sizeof(arena_buf));
    y8_val *v = y8_parse(&a, "42", 2);
    y8_val_project(v, &lo, &hi);
    TEST("val_project Y8_NUM", lo == 42.0 && hi == 42.0);

    /* val_project: Y8_BIGDEC → directed rounding */
    y8_arena_reset(&a);
    v = y8_parse(&a, "0.1M", 4);
    y8_val_project(v, &lo, &hi);
    TEST("val_project 0.1M", lo < hi);
}

/* ── Decimal comparison tests ────────────────────────────── */

static void test_decimal_cmp(void) {
    printf("\n=== Decimal comparison ===\n");

    TEST("equal", y8_decimal_cmp("42", 2, "42", 2) == 0);
    TEST("equal trailing zero", y8_decimal_cmp("42.0", 4, "42", 2) == 0);
    TEST("equal leading zero", y8_decimal_cmp("042", 3, "42", 2) == 0);
    TEST("equal decimal", y8_decimal_cmp("67432.50", 8, "67432.5", 7) == 0);
    TEST("less", y8_decimal_cmp("41", 2, "42", 2) == -1);
    TEST("greater", y8_decimal_cmp("43", 2, "42", 2) == 1);
    TEST("frac less", y8_decimal_cmp("0.1", 3, "0.2", 3) == -1);
    TEST("negative", y8_decimal_cmp("-1", 2, "1", 1) == -1);
    TEST("both negative", y8_decimal_cmp("-2", 2, "-1", 2) == -1);
    TEST("large equal", y8_decimal_cmp(
        "1000000000000000000000", 22,
        "1000000000000000000000", 22) == 0);
    TEST("large less", y8_decimal_cmp(
        "9007199254740992", 16,
        "9007199254740993", 16) == -1);
}

/* ── Benchmark ───────────────────────────────────────────── */

static void benchmark(void) {
    printf("\n=== Benchmark ===\n");

    /* Typical Prolog term serialization (persist hot path) */
    const char *msg =
        "{\"t\":\"c\",\"f\":\"reading\",\"a\":["
        "{\"t\":\"a\",\"n\":\"sensor_1\"},"
        "{\"t\":\"a\",\"n\":\"temperature\"},"
        "{\"t\":\"n\",\"v\":22},"
        "{\"t\":\"n\",\"v\":1710400000}]}";
    int msg_len = strlen(msg);

    char arena_bench[8192];
    y8_arena a;
    char out[512];
    int iterations = 1000000;

    /* Parse benchmark */
    {
        y8_arena_init(&a, arena_bench, sizeof(arena_bench));
        clock_t start = clock();
        for (int i = 0; i < iterations; i++) {
            y8_arena_reset(&a);
            y8_parse(&a, msg, msg_len);
        }
        clock_t end = clock();
        double ms = (double)(end - start) / CLOCKS_PER_SEC * 1000.0;
        printf("  Parse:     %d messages in %.1f ms (%.1f M msg/sec)\n",
               iterations, ms, iterations / ms / 1000.0);
    }

    /* Stringify benchmark */
    {
        y8_arena_init(&a, arena_bench, sizeof(arena_bench));
        y8_val *v = y8_parse(&a, msg, msg_len);
        clock_t start = clock();
        for (int i = 0; i < iterations; i++) {
            y8_stringify(v, out, sizeof(out));
        }
        clock_t end = clock();
        double ms = (double)(end - start) / CLOCKS_PER_SEC * 1000.0;
        printf("  Stringify: %d messages in %.1f ms (%.1f M msg/sec)\n",
               iterations, ms, iterations / ms / 1000.0);
    }

    /* Memory profile */
    {
        y8_arena_init(&a, arena_bench, sizeof(arena_bench));
        y8_parse(&a, msg, msg_len);
        printf("  Memory:    %zu bytes per parse (%zu byte arena, %d%% used)\n",
               a.used, sizeof(arena_bench), (int)(a.used * 100 / sizeof(arena_bench)));
        printf("  Message:   %d bytes input, %d bytes output\n",
               msg_len, (int)strlen(out));
        printf("  Malloc:    0 per message (arena-allocated)\n");
    }
}

/* ── Main ────────────────────────────────────────────────── */

int main(void) {
    test_parse_basic();
    test_parse_compound();
    test_parse_bignum();
    test_parse_comments();
    test_parse_human();
    test_stringify();
    test_project();
    test_decimal_cmp();
    benchmark();

    printf("\n%d/%d tests passed\n", pass, pass + fail);
    return fail ? 1 : 0;
}
