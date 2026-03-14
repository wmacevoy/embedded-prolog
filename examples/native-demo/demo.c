/* ============================================================
 * demo.c — Y@ in 30 lines of C
 *
 * A greenhouse sensor node: load policy rules, process readings,
 * query decisions.  Facts persist to SQLite.  After fossilize,
 * no injection can modify the rules.
 *
 * Requires QuickJS + SQLite3.  See native/wyatt.h for the API.
 *
 * Build:
 *   gcc -O2 -o demo demo.c ../../native/wyatt.c \
 *       -I../../native -I/path/to/quickjs -L/path/to/quickjs \
 *       -lquickjs -lsqlite3 -lm
 * ============================================================ */

#include <stdio.h>
#include "wyatt.h"

int main(void) {
    wyatt_t *w = wyatt_open("greenhouse.db");
    if (!w) { fprintf(stderr, "failed to open\n"); return 1; }

    /* Load greenhouse policy — pure Prolog */
    wyatt_load(w,
        "threshold(temperature, 5, 40).\n"
        "threshold(humidity, 20, 85).\n"
        "\n"
        "alert(Node, Type, high) :-\n"
        "    reading(Node, Type, Val, Ts),\n"
        "    threshold(Type, Min, Max),\n"
        "    Val > Max.\n"
        "\n"
        "alert(Node, Type, low) :-\n"
        "    reading(Node, Type, Val, Ts),\n"
        "    threshold(Type, Min, Max),\n"
        "    Val < Min.\n"
        "\n"
        "status(critical) :- alert(_, _, _).\n"
        "status(normal)   :- not(alert(_, _, _)).\n"
    );

    /* Freeze rules — no Prolog injection after this */
    wyatt_fossilize(w);
    printf("Rules fossilized.\n");

    /* Simulate sensor readings (these persist to SQLite) */
    wyatt_exec(w, "assert(reading(sensor_1, temperature, 22, 1000)).");
    wyatt_exec(w, "assert(reading(sensor_1, humidity, 45, 1001)).");
    printf("Readings asserted (persisted to greenhouse.db).\n");

    /* Query status */
    const char *r = wyatt_query(w, "status(S).");
    printf("Status: %s\n", r ? r : "unknown");

    /* Simulate overtemp */
    wyatt_exec(w, "retractall(reading(sensor_1, temperature, _, _)).");
    wyatt_exec(w, "assert(reading(sensor_1, temperature, 50, 1002)).");

    r = wyatt_query(w, "status(S).");
    printf("After overtemp: %s\n", r ? r : "unknown");

    r = wyatt_query(w, "alert(Node, Type, Level).");
    printf("Alert: %s\n", r ? r : "none");

    /* All readings survive restart — try running twice */
    const char *all = wyatt_query_all(w, "reading(N, T, V, Ts).", 10);
    printf("All readings: %s\n", all ? all : "[]");

    wyatt_close(w);
    return 0;
}
