/* ============================================================
 * y8.h — Embeddable y8 Prolog with reactive queries + SQLite
 *
 * QuickJS under the hood.  Text in, text out.
 *
 *   y8_t *w = y8_open("state.db");  // NULL for no persistence
 *   y8_load(w, "comfort(R) :- temperature(R,T), T > 18.");
 *   y8_exec(w, "assert(temperature(kitchen, 22)).");
 *   const char *r = y8_query(w, "comfort(R).");  // "comfort(kitchen)"
 *   y8_fossilize(w);  // freeze — no more assert/retract
 *   y8_close(w);
 *
 * Compile: gcc -O2 y8.c -lquickjs -lsqlite3
 * ============================================================ */

#ifndef Y8_H
#define Y8_H

#include <stdint.h>

typedef struct y8 y8_t;

/* ── Lifecycle ─────────────────────────────────────────────── */

/* Open engine.  db_path = SQLite file for persistence, NULL = memory only. */
y8_t       *y8_open(const char *db_path);
void        y8_close(y8_t *w);

/* ── Load Prolog source ────────────────────────────────────── */

/* Load Prolog text (facts + rules).  Returns clause count or -1 on error. */
int         y8_load(y8_t *w, const char *prolog_text);

/* ── Queries ───────────────────────────────────────────────── */

/* First solution as Prolog text.  Returns internal buffer (valid until
   next call), or NULL if no solution.  Caller does NOT free. */
const char *y8_query(y8_t *w, const char *goal_text);

/* All solutions as JSON array of strings.  Returns internal buffer. */
const char *y8_query_all(y8_t *w, const char *goal_text, int limit);

/* Execute for side effects (assert/retract).  Returns 1 if succeeded, 0 if failed. */
int         y8_exec(y8_t *w, const char *goal_text);

/* ── Security ──────────────────────────────────────────────── */

/* Freeze clause database.  Only ephemeral facts allowed after this.
   Returns fossil boundary (clause count at freeze). */
int         y8_fossilize(y8_t *w);

/* ── Error handling ────────────────────────────────────────── */

/* Last error message, or NULL.  Valid until next call. */
const char *y8_error(y8_t *w);

#endif /* Y8_H */
