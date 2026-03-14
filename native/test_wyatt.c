/* ============================================================
 * test_wyatt.c — Test the wyatt embeddable
 *
 * Compile (adjust paths to your QuickJS install):
 *   gcc -O2 -o test_wyatt wyatt.c test_wyatt.c \
 *       -I/usr/local/include -L/usr/local/lib \
 *       -lquickjs -lsqlite3 -lm -lpthread
 * ============================================================ */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "wyatt.h"

static int pass = 0, fail = 0;

#define TEST(name, cond) do { \
    if (cond) { pass++; printf("  ok  %s\n", name); } \
    else { fail++; printf("  FAIL %s\n", name); } \
} while(0)

int main(void) {
    printf("=== wyatt embeddable ===\n\n");

    /* ── Basic engine (no persistence) ───────────────── */
    printf("--- No persistence ---\n");
    {
        wyatt_t *w = wyatt_open(NULL);
        TEST("open without db", w != NULL);

        int n = wyatt_load(w, "color(sky, blue). color(grass, green).");
        TEST("load 2 facts", n == 2);

        const char *r = wyatt_query(w, "color(sky, X)");
        TEST("query color(sky,X)", r != NULL && strstr(r, "blue") != NULL);

        r = wyatt_query(w, "color(ocean, X)");
        TEST("query no match", r == NULL);

        const char *all = wyatt_query_all(w, "color(X, Y)", 10);
        TEST("query_all returns array", all != NULL && all[0] == '[');

        wyatt_close(w);
    }

    /* ── Rules and arithmetic ────────────────────────── */
    printf("\n--- Rules ---\n");
    {
        wyatt_t *w = wyatt_open(NULL);

        wyatt_load(w,
            "parent(tom, bob). parent(bob, ann).\n"
            "grandparent(X, Z) :- parent(X, Y), parent(Y, Z).\n"
        );
        const char *r = wyatt_query(w, "grandparent(tom, Z)");
        TEST("grandparent rule", r != NULL && strstr(r, "ann") != NULL);

        wyatt_load(w, "double(X, Y) :- Y is X * 2.");
        r = wyatt_query(w, "double(21, Y)");
        TEST("arithmetic", r != NULL && strstr(r, "42") != NULL);

        wyatt_close(w);
    }

    /* ── Assert / retract ────────────────────────────── */
    printf("\n--- Dynamic ---\n");
    {
        wyatt_t *w = wyatt_open(NULL);

        int ok = wyatt_exec(w, "assert(temp(kitchen, 22))");
        TEST("assert succeeds", ok == 1);

        const char *r = wyatt_query(w, "temp(kitchen, T)");
        TEST("query asserted fact", r != NULL && strstr(r, "22") != NULL);

        wyatt_exec(w, "retract(temp(kitchen, 22))");
        r = wyatt_query(w, "temp(kitchen, T)");
        TEST("retracted fact gone", r == NULL);

        wyatt_close(w);
    }

    /* ── Fossilize ───────────────────────────────────── */
    printf("\n--- Fossilize ---\n");
    {
        wyatt_t *w = wyatt_open(NULL);

        wyatt_load(w, "trusted(sensor_1).");
        int boundary = wyatt_fossilize(w);
        TEST("fossilize returns boundary", boundary > 0);

        int ok = wyatt_exec(w, "assert(trusted(evil))");
        TEST("assert blocked after fossilize", ok == 0);

        const char *r = wyatt_query(w, "trusted(sensor_1)");
        TEST("original fact survives", r != NULL);

        r = wyatt_query(w, "trusted(evil)");
        TEST("injected fact rejected", r == NULL);

        wyatt_close(w);
    }

    /* ── Persistence ─────────────────────────────────── */
    printf("\n--- Persistence ---\n");
    {
        const char *db = "/tmp/wyatt_test.db";
        remove(db);

        /* Session 1: assert facts */
        wyatt_t *w1 = wyatt_open(db);
        TEST("open with db", w1 != NULL);
        wyatt_exec(w1, "assert(reading(s1, 25))");
        wyatt_exec(w1, "assert(reading(s2, 30))");
        wyatt_close(w1);

        /* Session 2: facts should survive */
        wyatt_t *w2 = wyatt_open(db);
        const char *r = wyatt_query(w2, "reading(s1, T)");
        TEST("fact survives restart", r != NULL && strstr(r, "25") != NULL);

        const char *all = wyatt_query_all(w2, "reading(X, T)", 10);
        TEST("all readings restored", all != NULL && strstr(all, "s2") != NULL);
        wyatt_close(w2);

        remove(db);
        /* clean up WAL/SHM */
        char wal[256], shm[256];
        snprintf(wal, sizeof(wal), "%s-wal", db);
        snprintf(shm, sizeof(shm), "%s-shm", db);
        remove(wal);
        remove(shm);
    }

    /* ── Summary ─────────────────────────────────────── */
    printf("\n%d/%d tests passed\n", pass, pass + fail);
    return fail ? 1 : 0;
}
