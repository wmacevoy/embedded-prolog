/* ============================================================
 * test_wyatt.c — Tests for the wyatt C engine
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "wyatt.h"

static int pass = 0, fail = 0;

#define TEST(name, cond) do { \
    if (cond) { pass++; printf("  ok  %s\n", name); } \
    else { fail++; printf("  FAIL %s  [line %d]\n", name, __LINE__); } \
} while(0)

static void test_lifecycle(void) {
    printf("=== Lifecycle ===\n");
    wyatt_t *w = wyatt_open(":memory:", NULL);
    TEST("open", w != NULL);
    if (w) {
        TEST("error is empty", wyatt_error(w)[0] == '\0');
        wyatt_close(w);
    }
}

static void test_load(void) {
    printf("\n=== Load ===\n");
    wyatt_t *w = wyatt_open(":memory:", NULL);
    if (!w) { fail++; printf("  FAIL open\n"); return; }

    int count = wyatt_load(w, "parent(alice, bob). parent(bob, carol).");
    TEST("load 2 clauses", count == 2);

    wyatt_close(w);
}

static void test_send(void) {
    printf("\n=== Send ===\n");
    wyatt_t *w = wyatt_open(":memory:", NULL);
    if (!w) { fail++; return; }

    wyatt_send(w, "\"alerts\"", "\"overheat\"");
    char *sends = wyatt_collect_sends(w);
    TEST("collect sends", sends != NULL);
    TEST("sends not empty", strcmp(sends, "[]") != 0);
    wyatt_free(sends);

    sends = wyatt_collect_sends(w);
    TEST("sends cleared", strcmp(sends, "[]") == 0);
    wyatt_free(sends);

    wyatt_close(w);
}

static void test_react(void) {
    printf("\n=== React ===\n");
    wyatt_t *w = wyatt_open(":memory:", NULL);
    if (!w) { fail++; return; }

    int rc = wyatt_react(w, "alert", "[]");
    TEST("add react rule", rc == 0);

    rc = wyatt_ephemeral(w, "alert", "temp", "[\"sensor1\", 35]");
    TEST("fire ephemeral", rc == 0);

    wyatt_close(w);
}

static void test_native(void) {
    printf("\n=== Native ===\n");
    wyatt_t *w = wyatt_open(":memory:", NULL);
    if (!w) { fail++; return; }

    int rc = wyatt_native(w, "double", NULL, NULL);
    TEST("null fn rejected", rc == -1);

    wyatt_close(w);
}

int main(void) {
    test_lifecycle();
    test_load();
    test_send();
    test_react();
    test_native();

    printf("\n%d/%d tests passed\n", pass, pass + fail);
    return fail ? 1 : 0;
}
