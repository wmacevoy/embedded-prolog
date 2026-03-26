/* ============================================================
 * wyatt.c — Reactive Datalog engine
 *
 * SQLite/SQLCipher + qjson_ext + QuickJS + libbf + LibreSSL
 * ============================================================ */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sqlite3.h>
#include "quickjs.h"
#include "qjson.h"
#include "wyatt.h"

/* Forward declarations for qjson_ext auto-registration */
extern int sqlite3_qjsonext_init(sqlite3 *db, char **pzErrMsg,
                                  const sqlite3_api_routines *pApi);

/* ── React rule ──────────────────────────────────────────── */

typedef struct {
    char *pattern;        /* event type to match */
    char *body_qjson;     /* body goals as QJSON array string */
} wyatt_react_rule;

/* ── Native hook entry ───────────────────────────────────── */

typedef struct {
    char *name;
    wyatt_native_fn fn;
    void *ctx;
} wyatt_native_entry;

/* ── Send entry ──────────────────────────────────────────── */

typedef struct {
    char *target;
    char *message;
} wyatt_send_entry;

/* ── Engine struct ───────────────────────────────────────── */

struct wyatt {
    sqlite3 *db;
    JSRuntime *rt;
    JSContext *js;
    JSValue parse_program_fn;   /* JS function: parseProgram(text) */
    int root_id;
    char error[512];

    wyatt_react_rule *reacts;
    int react_count;
    int react_cap;

    wyatt_native_entry *natives;
    int native_count;
    int native_cap;

    wyatt_send_entry *sends;
    int send_count;
    int send_cap;
};

/* ── Helpers ─────────────────────────────────────────────── */

static char *_strdup(const char *s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    char *d = malloc(len + 1);
    if (d) memcpy(d, s, len + 1);
    return d;
}

static void _set_error(wyatt_t *w, const char *msg) {
    if (w && msg) {
        strncpy(w->error, msg, sizeof(w->error) - 1);
        w->error[sizeof(w->error) - 1] = '\0';
    }
}

/* ── SQL helpers ─────────────────────────────────────────── */

static int _exec(wyatt_t *w, const char *sql) {
    char *err = NULL;
    int rc = sqlite3_exec(w->db, sql, NULL, NULL, &err);
    if (rc != SQLITE_OK) {
        _set_error(w, err ? err : "SQL error");
        if (err) sqlite3_free(err);
        return -1;
    }
    return 0;
}

static sqlite3_int64 _exec_insert(wyatt_t *w, const char *sql) {
    if (_exec(w, sql) < 0) return -1;
    return sqlite3_last_insert_rowid(w->db);
}

/* ── Lifecycle ───────────────────────────────────────────── */

/* Embedded parser.js source — generated at build time or loaded from file */
static const char *_find_parser_js(void) {
    /* Try to read from file first */
    static char buf[65536];
    FILE *f = fopen("src/parser.js", "r");
    if (!f) f = fopen("../src/parser.js", "r");
    if (!f) return NULL;
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    return buf;
}

/* Strip ESM import/export lines from parser.js for QuickJS eval */
static char *_strip_esm(const char *src) {
    if (!src) return NULL;
    size_t len = strlen(src);
    char *out = malloc(len + 1);
    if (!out) return NULL;
    int oi = 0;
    const char *p = src;
    while (*p) {
        /* Skip lines starting with "import " or "export " */
        const char *line = p;
        while (*p && *p != '\n') p++;
        int line_len = (int)(p - line);
        if (*p == '\n') p++;
        /* Check if line starts with import or export (after trimming spaces) */
        const char *t = line;
        while (t < line + line_len && (*t == ' ' || *t == '\t')) t++;
        if (strncmp(t, "import ", 7) == 0 || strncmp(t, "export ", 7) == 0)
            continue;
        memcpy(out + oi, line, line_len);
        oi += line_len;
        out[oi++] = '\n';
    }
    out[oi] = '\0';
    return out;
}

static int _init_quickjs(wyatt_t *w) {
    w->rt = JS_NewRuntime();
    if (!w->rt) { _set_error(w, "QuickJS: failed to create runtime"); return -1; }

    w->js = JS_NewContext(w->rt);
    if (!w->js) { _set_error(w, "QuickJS: failed to create context"); return -1; }

    /* Load parser.js */
    const char *parser_src = _find_parser_js();
    if (!parser_src) { _set_error(w, "parser.js not found"); return -1; }

    char *clean = _strip_esm(parser_src);
    if (!clean) { _set_error(w, "failed to process parser.js"); return -1; }

    JSValue result = JS_Eval(w->js, clean, strlen(clean), "parser.js", JS_EVAL_TYPE_GLOBAL);
    free(clean);

    if (JS_IsException(result)) {
        _set_error(w, "parser.js eval failed");
        JS_FreeValue(w->js, result);
        return -1;
    }
    JS_FreeValue(w->js, result);

    /* Get parseProgram function */
    JSValue global = JS_GetGlobalObject(w->js);
    w->parse_program_fn = JS_GetPropertyStr(w->js, global, "parseProgram");
    JS_FreeValue(w->js, global);

    if (JS_IsUndefined(w->parse_program_fn)) {
        _set_error(w, "parseProgram not found in parser.js");
        return -1;
    }
    return 0;
}

static int _init_qjson(wyatt_t *w) {
    /* Register qjson_ext functions directly */
    char *err = NULL;
    int rc = sqlite3_qjsonext_init(w->db, &err, NULL);
    if (rc != SQLITE_OK) {
        _set_error(w, err ? err : "failed to register qjson extension");
        return -1;
    }

    /* Create qjson schema */
    const char *schema[] = {
        "CREATE TABLE IF NOT EXISTS qjson_value (id INTEGER PRIMARY KEY, type TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS qjson_number (id INTEGER PRIMARY KEY, value_id INTEGER, lo REAL, str TEXT, hi REAL)",
        "CREATE TABLE IF NOT EXISTS qjson_string (id INTEGER PRIMARY KEY, value_id INTEGER, value TEXT)",
        "CREATE TABLE IF NOT EXISTS qjson_blob (id INTEGER PRIMARY KEY, value_id INTEGER, value BLOB)",
        "CREATE TABLE IF NOT EXISTS qjson_array (id INTEGER PRIMARY KEY, value_id INTEGER)",
        "CREATE TABLE IF NOT EXISTS qjson_array_item (id INTEGER PRIMARY KEY, array_id INTEGER, idx INTEGER, value_id INTEGER)",
        "CREATE TABLE IF NOT EXISTS qjson_object (id INTEGER PRIMARY KEY, value_id INTEGER)",
        "CREATE TABLE IF NOT EXISTS qjson_object_item (id INTEGER PRIMARY KEY, object_id INTEGER, key_id INTEGER, value_id INTEGER)",
        "CREATE INDEX IF NOT EXISTS ix_qn_vid ON qjson_number(value_id)",
        "CREATE INDEX IF NOT EXISTS ix_qn_lo ON qjson_number(lo)",
        "CREATE INDEX IF NOT EXISTS ix_qn_hi ON qjson_number(hi)",
        "CREATE INDEX IF NOT EXISTS ix_qs_vid ON qjson_string(value_id)",
        "CREATE INDEX IF NOT EXISTS ix_qb_vid ON qjson_blob(value_id)",
        "CREATE INDEX IF NOT EXISTS ix_qa_vid ON qjson_array(value_id)",
        "CREATE INDEX IF NOT EXISTS ix_qai_aid ON qjson_array_item(array_id)",
        "CREATE INDEX IF NOT EXISTS ix_qo_vid ON qjson_object(value_id)",
        "CREATE INDEX IF NOT EXISTS ix_qoi_oid ON qjson_object_item(object_id)",
        "CREATE INDEX IF NOT EXISTS ix_qoi_kid ON qjson_object_item(key_id)",
        NULL
    };
    for (int i = 0; schema[i]; i++) {
        if (_exec(w, schema[i]) < 0) return -1;
    }

    /* Store empty root document: {} → type "object" with no items */
    if (_exec(w, "INSERT INTO qjson_value (type) VALUES ('object')") < 0) return -1;
    w->root_id = (int)sqlite3_last_insert_rowid(w->db);
    int obj_id_sql = (int)_exec_insert(w,
        "INSERT INTO qjson_object (value_id) VALUES (1)");
    if (obj_id_sql < 0) return -1;

    return 0;
}

wyatt_t *wyatt_open(const char *db_path, const char *key) {
    wyatt_t *w = calloc(1, sizeof(wyatt_t));
    if (!w) return NULL;

    /* Open SQLite/SQLCipher */
    int rc = sqlite3_open(db_path ? db_path : ":memory:", &w->db);
    if (rc != SQLITE_OK) {
        _set_error(w, sqlite3_errmsg(w->db));
        wyatt_close(w);
        return NULL;
    }

    /* SQLCipher key */
    if (key && key[0]) {
        char sql[256];
        snprintf(sql, sizeof(sql), "PRAGMA key = '%s'", key);
        _exec(w, sql);
    }
    _exec(w, "PRAGMA journal_mode=WAL");

    /* Initialize qjson schema + extension */
    if (_init_qjson(w) < 0) {
        wyatt_close(w);
        return NULL;
    }

    /* Initialize QuickJS + parser.js */
    if (_init_quickjs(w) < 0) {
        wyatt_close(w);
        return NULL;
    }

    return w;
}

void wyatt_close(wyatt_t *w) {
    if (!w) return;

    /* Free react rules */
    for (int i = 0; i < w->react_count; i++) {
        free(w->reacts[i].pattern);
        free(w->reacts[i].body_qjson);
    }
    free(w->reacts);

    /* Free native hooks */
    for (int i = 0; i < w->native_count; i++) {
        free(w->natives[i].name);
    }
    free(w->natives);

    /* Free sends */
    for (int i = 0; i < w->send_count; i++) {
        free(w->sends[i].target);
        free(w->sends[i].message);
    }
    free(w->sends);

    /* Free QuickJS */
    if (w->js) {
        if (!JS_IsUndefined(w->parse_program_fn))
            JS_FreeValue(w->js, w->parse_program_fn);
        JS_FreeContext(w->js);
    }
    if (w->rt) JS_FreeRuntime(w->rt);

    /* Close SQLite */
    if (w->db) sqlite3_close(w->db);

    free(w);
}

void wyatt_free(char *str) {
    free(str);
}

const char *wyatt_error(wyatt_t *w) {
    return w ? w->error : "null engine";
}

/* ── Load Prolog text ────────────────────────────────────── */

int wyatt_load(wyatt_t *w, const char *prolog_text) {
    if (!w || !prolog_text) return -1;

    /* Call parseProgram(text) via QuickJS */
    JSValue text_val = JS_NewString(w->js, prolog_text);
    JSValue global = JS_GetGlobalObject(w->js);
    JSValue result = JS_Call(w->js, w->parse_program_fn, global, 1, &text_val);
    JS_FreeValue(w->js, text_val);
    JS_FreeValue(w->js, global);

    if (JS_IsException(result)) {
        _set_error(w, "parseProgram failed");
        JS_FreeValue(w->js, result);
        return -1;
    }

    /* result is an array of {head, body} objects */
    /* TODO: walk the JS array, extract head/body, call wyatt_assert/add_rule */
    /* For now, just return the count */

    int count = 0;
    if (JS_IsArray(w->js, result)) {
        JSValue len_val = JS_GetPropertyStr(w->js, result, "length");
        int32_t len = 0;
        JS_ToInt32(w->js, &len, len_val);
        JS_FreeValue(w->js, len_val);
        count = len;

        /* TODO: iterate clauses and process them */
    }

    JS_FreeValue(w->js, result);
    return count;
}

/* ── Facts (stub — TODO: implement via qjson SQL) ────────── */

int wyatt_assert(wyatt_t *w, const char *predicate, const char *args_qjson) {
    if (!w || !predicate) return -1;
    /* TODO: parse args, store as set member in root.predicate */
    return 0;
}

int wyatt_retract(wyatt_t *w, const char *predicate, const char *args_qjson) {
    if (!w || !predicate) return 0;
    /* TODO */
    return 0;
}

int wyatt_retract_all(wyatt_t *w, const char *predicate, const char *pattern_qjson) {
    if (!w || !predicate) return 0;
    /* TODO */
    return 0;
}

char *wyatt_query(wyatt_t *w, const char *predicate, const char *pattern_qjson) {
    if (!w || !predicate) return _strdup("[]");
    /* TODO: build qjson_select SQL, execute, format results */
    return _strdup("[]");
}

char *wyatt_resolve(wyatt_t *w, const char *predicate, const char *pattern_qjson) {
    if (!w || !predicate) return _strdup("[]");
    /* TODO: query + rules + closure */
    return _strdup("[]");
}

/* ── Body execution (stub) ───────────────────────────────── */

int wyatt_execute(wyatt_t *w, const char *goals_qjson, const char *bindings_qjson) {
    if (!w) return 0;
    /* TODO */
    return 0;
}

/* ── Events ──────────────────────────────────────────────── */

int wyatt_ephemeral(wyatt_t *w, const char *event_type,
                    const char *predicate, const char *fact_qjson) {
    if (!w) return -1;
    /* Fire matching react rules */
    for (int i = 0; i < w->react_count; i++) {
        if (strcmp(w->reacts[i].pattern, event_type) == 0 ||
            strcmp(w->reacts[i].pattern, "*") == 0) {
            wyatt_execute(w, w->reacts[i].body_qjson, NULL);
        }
    }
    return 0;
}

int wyatt_react(wyatt_t *w, const char *event_pattern,
                const char *body_goals_qjson) {
    if (!w || !event_pattern) return -1;
    /* Grow array if needed */
    if (w->react_count >= w->react_cap) {
        int new_cap = w->react_cap ? w->react_cap * 2 : 8;
        wyatt_react_rule *new_rules = realloc(w->reacts, new_cap * sizeof(wyatt_react_rule));
        if (!new_rules) return -1;
        w->reacts = new_rules;
        w->react_cap = new_cap;
    }
    w->reacts[w->react_count].pattern = _strdup(event_pattern);
    w->reacts[w->react_count].body_qjson = _strdup(body_goals_qjson);
    w->react_count++;
    return 0;
}

/* ── Native hooks ────────────────────────────────────────── */

int wyatt_native(wyatt_t *w, const char *name, wyatt_native_fn fn, void *ctx) {
    if (!w || !name || !fn) return -1;
    if (w->native_count >= w->native_cap) {
        int new_cap = w->native_cap ? w->native_cap * 2 : 8;
        wyatt_native_entry *ne = realloc(w->natives, new_cap * sizeof(wyatt_native_entry));
        if (!ne) return -1;
        w->natives = ne;
        w->native_cap = new_cap;
    }
    w->natives[w->native_count].name = _strdup(name);
    w->natives[w->native_count].fn = fn;
    w->natives[w->native_count].ctx = ctx;
    w->native_count++;
    return 0;
}

/* ── Send ────────────────────────────────────────────────── */

int wyatt_send(wyatt_t *w, const char *target, const char *message_qjson) {
    if (!w || !target) return -1;
    if (w->send_count >= w->send_cap) {
        int new_cap = w->send_cap ? w->send_cap * 2 : 8;
        wyatt_send_entry *ne = realloc(w->sends, new_cap * sizeof(wyatt_send_entry));
        if (!ne) return -1;
        w->sends = ne;
        w->send_cap = new_cap;
    }
    w->sends[w->send_count].target = _strdup(target);
    w->sends[w->send_count].message = _strdup(message_qjson);
    w->send_count++;
    return 0;
}

char *wyatt_collect_sends(wyatt_t *w) {
    if (!w || w->send_count == 0) return _strdup("[]");
    /* Build QJSON array of {target, message} objects */
    /* Simple: just concatenate as JSON */
    size_t cap = 256;
    char *buf = malloc(cap);
    int pos = 0;
    buf[pos++] = '[';
    for (int i = 0; i < w->send_count; i++) {
        if (i > 0) buf[pos++] = ',';
        int n = snprintf(buf + pos, cap - pos,
            "{\"target\":%s,\"message\":%s}",
            w->sends[i].target, w->sends[i].message);
        pos += n;
        if ((size_t)pos >= cap - 100) {
            cap *= 2;
            buf = realloc(buf, cap);
        }
        free(w->sends[i].target);
        free(w->sends[i].message);
    }
    buf[pos++] = ']';
    buf[pos] = '\0';
    w->send_count = 0;
    return buf;
}

/* ── Crypto (delegate to qjson_crypto if available) ──────── */

#ifdef QJSON_USE_CRYPTO
#include "qjson_crypto.h"
/* TODO: implement wyatt_sha256 etc. using qjson_crypto functions */
#endif
