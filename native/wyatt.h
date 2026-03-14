/* ============================================================
 * wyatt.h — Embeddable Y@ Prolog with reactive queries + SQLite
 *
 * QuickJS under the hood.  Text in, text out.
 *
 *   wyatt_t *w = wyatt_open("state.db");  // NULL for no persistence
 *   wyatt_load(w, "comfort(R) :- temperature(R,T), T > 18.");
 *   wyatt_exec(w, "assert(temperature(kitchen, 22)).");
 *   const char *r = wyatt_query(w, "comfort(R).");  // "comfort(kitchen)"
 *   wyatt_fossilize(w);  // freeze — no more assert/retract
 *   wyatt_close(w);
 *
 * Compile: gcc -O2 wyatt.c -lquickjs -lsqlite3
 * ============================================================ */

#ifndef WYATT_H
#define WYATT_H

#include <stdint.h>

typedef struct wyatt wyatt_t;

/* ── Lifecycle ─────────────────────────────────────────────── */

/* Open engine.  db_path = SQLite file for persistence, NULL = memory only. */
wyatt_t    *wyatt_open(const char *db_path);
void        wyatt_close(wyatt_t *w);

/* ── Load Prolog source ────────────────────────────────────── */

/* Load Prolog text (facts + rules).  Returns clause count or -1 on error. */
int         wyatt_load(wyatt_t *w, const char *prolog_text);

/* ── Queries ───────────────────────────────────────────────── */

/* First solution as Prolog text.  Returns internal buffer (valid until
   next call), or NULL if no solution.  Caller does NOT free. */
const char *wyatt_query(wyatt_t *w, const char *goal_text);

/* All solutions as JSON array of strings.  Returns internal buffer. */
const char *wyatt_query_all(wyatt_t *w, const char *goal_text, int limit);

/* Execute for side effects (assert/retract).  Returns 1 if succeeded, 0 if failed. */
int         wyatt_exec(wyatt_t *w, const char *goal_text);

/* ── Security ──────────────────────────────────────────────── */

/* Freeze clause database.  Only ephemeral facts allowed after this.
   Returns fossil boundary (clause count at freeze). */
int         wyatt_fossilize(wyatt_t *w);

/* ── Error handling ────────────────────────────────────────── */

/* Last error message, or NULL.  Valid until next call. */
const char *wyatt_error(wyatt_t *w);

#endif /* WYATT_H */
