/* ============================================================
 * wyatt.h — Reactive Datalog engine
 *
 * SQLCipher + libbf + LibreSSL + QuickJS + qjson
 * Text in, text out.  All args/returns are QJSON strings.
 *
 * Usage:
 *   wyatt_t *w = wyatt_open(":memory:", NULL);
 *   wyatt_load(w, "parent(alice, bob). parent(bob, carol).");
 *   char *r = wyatt_query(w, "parent", "[null, \"bob\"]");
 *   // r = "[[\"alice\",\"bob\"]]"
 *   wyatt_free(r);
 *   wyatt_close(w);
 * ============================================================ */

#ifndef WYATT_H
#define WYATT_H

#include <stddef.h>

typedef struct wyatt wyatt_t;

/* ── Lifecycle ───────────────────────────────────────────── */

/* Open engine.  db_path: ":memory:" or file path.
   key: SQLCipher passphrase (NULL for unencrypted). */
wyatt_t *wyatt_open(const char *db_path, const char *key);

/* Close engine and free all resources. */
void wyatt_close(wyatt_t *w);

/* Free a string returned by wyatt_query/resolve/etc. */
void wyatt_free(char *str);

/* ── Load Prolog text ────────────────────────────────────── */

/* Parse Prolog text, assert facts and add rules.
   Returns number of clauses loaded, or -1 on error. */
int wyatt_load(wyatt_t *w, const char *prolog_text);

/* ── Facts ───────────────────────────────────────────────── */

/* Assert fact.  args is QJSON array: ["alice", "bob"]
   Returns 0 on success. */
int wyatt_assert(wyatt_t *w, const char *predicate, const char *args_qjson);

/* Retract exact fact.  Returns 1 if found and removed, 0 if not. */
int wyatt_retract(wyatt_t *w, const char *predicate, const char *args_qjson);

/* Retract all matching.  Pattern: null = wildcard.
   Returns count of retracted facts. */
int wyatt_retract_all(wyatt_t *w, const char *predicate, const char *pattern_qjson);

/* ── Query ───────────────────────────────────────────────── */

/* Query facts matching pattern.  Returns QJSON array of fact tuples.
   pattern: QJSON array (null = wildcard), or NULL for all.
   Caller must wyatt_free() the result. */
char *wyatt_query(wyatt_t *w, const char *predicate, const char *pattern_qjson);

/* Resolve: facts + rules + closure.
   Returns QJSON array of binding objects.
   Caller must wyatt_free() the result. */
char *wyatt_resolve(wyatt_t *w, const char *predicate, const char *pattern_qjson);

/* ── Body execution ──────────────────────────────────────── */

/* Execute a list of body goals with bindings.
   goals: QJSON array of goal arrays.
   bindings: QJSON object (in/out), or NULL.
   Returns 1 if all goals succeed, 0 if any fails. */
int wyatt_execute(wyatt_t *w, const char *goals_qjson, const char *bindings_qjson);

/* ── Events ──────────────────────────────────────────────── */

/* Fire ephemeral event (not stored). */
int wyatt_ephemeral(wyatt_t *w, const char *event_type,
                    const char *predicate, const char *fact_qjson);

/* Register react rule (body goals executed on event match). */
int wyatt_react(wyatt_t *w, const char *event_pattern,
                const char *body_goals_qjson);

/* ── Native hooks ────────────────────────────────────────── */

/* Native function callback.  args is QJSON array.
   Return a QJSON string (caller frees), or NULL. */
typedef char *(*wyatt_native_fn)(const char *args_qjson, void *ctx);

/* Register a native hook. */
int wyatt_native(wyatt_t *w, const char *name, wyatt_native_fn fn, void *ctx);

/* ── Send ────────────────────────────────────────────────── */

/* Buffer an outgoing message. */
int wyatt_send(wyatt_t *w, const char *target, const char *message_qjson);

/* Collect and clear buffered sends.  Returns QJSON array.
   Caller must wyatt_free() the result. */
char *wyatt_collect_sends(wyatt_t *w);

/* ── Crypto ──────────────────────────────────────────────── */

char *wyatt_sha256(const char *data, int len);
char *wyatt_hmac(const char *data, int data_len,
                 const char *key, int key_len);
char *wyatt_encrypt(const char *plaintext, int len, const char *key);
char *wyatt_decrypt(const char *ciphertext, int len, const char *key);
char *wyatt_random_bytes(int n);
char *wyatt_hkdf(const char *ikm, int ikm_len,
                 const char *salt, int salt_len,
                 const char *info, int info_len, int out_len);
char *wyatt_jwt_sign(const char *payload, const char *secret);
char *wyatt_jwt_verify(const char *token, const char *secret);
char *wyatt_shamir_split(const char *secret, int secret_len, int m, int n);
char *wyatt_shamir_recover(const char *shares_qjson);

/* ── Error ───────────────────────────────────────────────── */

/* Last error message (static, do not free). */
const char *wyatt_error(wyatt_t *w);

#endif
