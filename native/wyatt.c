/* ============================================================
 * wyatt.c — Embeddable Y@ Prolog: QuickJS + SQLite
 *
 * Text in, text out.  ~300 lines of glue.
 *
 * Compile (example):
 *   gcc -O2 -o test_wyatt wyatt.c test_wyatt.c \
 *       -I/path/to/quickjs -L/path/to/quickjs -lquickjs -lm \
 *       -lsqlite3
 * ============================================================ */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sqlite3.h>
#include "quickjs.h"
#include "wyatt.h"
#include "wyatt_js_embed.h"

/* ── Internal state ──────────────────────────────────────── */

struct wyatt {
    JSRuntime  *rt;
    JSContext  *ctx;
    sqlite3    *db;
    char       *result_buf;   /* owned, reused between calls */
    size_t      result_cap;
    char        error_buf[512];
};

/* ── Helpers ─────────────────────────────────────────────── */

static void set_error(wyatt_t *w, const char *msg) {
    snprintf(w->error_buf, sizeof(w->error_buf), "%s", msg);
}

static void clear_error(wyatt_t *w) {
    w->error_buf[0] = '\0';
}

static int check_exception(wyatt_t *w, JSValue val) {
    if (!JS_IsException(val)) return 0;
    JSValue exc = JS_GetException(w->ctx);
    const char *s = JS_ToCString(w->ctx, exc);
    set_error(w, s ? s : "JS exception");
    if (s) JS_FreeCString(w->ctx, s);
    JS_FreeValue(w->ctx, exc);
    return 1;
}

static void set_result(wyatt_t *w, const char *s) {
    size_t len = strlen(s) + 1;
    if (len > w->result_cap) {
        free(w->result_buf);
        w->result_cap = len * 2;
        w->result_buf = malloc(w->result_cap);
    }
    memcpy(w->result_buf, s, len);
}

static int eval_embedded(wyatt_t *w, const char *src, const char *name) {
    JSValue r = JS_Eval(w->ctx, src, strlen(src), name, JS_EVAL_TYPE_GLOBAL);
    if (check_exception(w, r)) { JS_FreeValue(w->ctx, r); return -1; }
    JS_FreeValue(w->ctx, r);
    return 0;
}

/* ── SQLite bindings for JS ──────────────────────────────── */

static JSValue js_db_exec(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    (void)this_val;
    wyatt_t *w = JS_GetContextOpaque(ctx);
    if (!w->db || argc < 1) return JS_UNDEFINED;
    const char *sql = JS_ToCString(ctx, argv[0]);
    if (sql) {
        sqlite3_exec(w->db, sql, NULL, NULL, NULL);
        JS_FreeCString(ctx, sql);
    }
    return JS_UNDEFINED;
}

static JSValue js_db_run(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    (void)this_val;
    wyatt_t *w = JS_GetContextOpaque(ctx);
    if (!w->db || argc < 1) return JS_UNDEFINED;
    const char *sql = JS_ToCString(ctx, argv[0]);
    if (!sql) return JS_UNDEFINED;

    sqlite3_stmt *stmt = NULL;
    sqlite3_prepare_v2(w->db, sql, -1, &stmt, NULL);
    JS_FreeCString(ctx, sql);
    if (!stmt) return JS_UNDEFINED;

    /* Bind string parameters from remaining args */
    for (int i = 1; i < argc; i++) {
        if (JS_IsNull(argv[i]) || JS_IsUndefined(argv[i])) {
            sqlite3_bind_null(stmt, i);
        } else if (JS_IsNumber(argv[i])) {
            int32_t v;
            JS_ToInt32(ctx, &v, argv[i]);
            sqlite3_bind_int(stmt, i, v);
        } else {
            const char *s = JS_ToCString(ctx, argv[i]);
            if (s) {
                sqlite3_bind_text(stmt, i, s, -1, SQLITE_TRANSIENT);
                JS_FreeCString(ctx, s);
            }
        }
    }
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return JS_UNDEFINED;
}

static JSValue js_db_all(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    (void)this_val;
    wyatt_t *w = JS_GetContextOpaque(ctx);
    if (!w->db || argc < 1) return JS_NewArray(ctx);
    const char *sql = JS_ToCString(ctx, argv[0]);
    if (!sql) return JS_NewArray(ctx);

    sqlite3_stmt *stmt = NULL;
    sqlite3_prepare_v2(w->db, sql, -1, &stmt, NULL);
    JS_FreeCString(ctx, sql);
    if (!stmt) return JS_NewArray(ctx);

    /* Bind parameters */
    for (int i = 1; i < argc; i++) {
        if (JS_IsNumber(argv[i])) {
            int32_t v;
            JS_ToInt32(ctx, &v, argv[i]);
            sqlite3_bind_int(stmt, i, v);
        } else {
            const char *s = JS_ToCString(ctx, argv[i]);
            if (s) {
                sqlite3_bind_text(stmt, i, s, -1, SQLITE_TRANSIENT);
                JS_FreeCString(ctx, s);
            }
        }
    }

    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *val = (const char *)sqlite3_column_text(stmt, 0);
        if (val) JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, val));
    }
    sqlite3_finalize(stmt);
    return arr;
}

static JSValue js_db_commit(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    /* SQLite autocommit — no-op */
    return JS_UNDEFINED;
}

/* ── Bootstrap JS: create engine + wire persist/fossilize ── */

static const char js_bootstrap[] =
  "var _engine = new PrologEngine();\n"
  "var _reactive = createReactiveEngine(_engine);\n"
  "var _adapter = null;\n"
  "var _persisted = false;\n"
  "\n"
  "function _wyatt_setup_persist() {\n"
  "  _adapter = {\n"
  "    setup: function() {\n"
  "      __db_exec('CREATE TABLE IF NOT EXISTS facts '\n"
  "        + '(term TEXT PRIMARY KEY, functor TEXT, arity INTEGER)');\n"
  "      __db_exec('CREATE INDEX IF NOT EXISTS idx_facts_pred '\n"
  "        + 'ON facts(functor, arity)');\n"
  "    },\n"
  "    insert: function(key, functor, arity) {\n"
  "      __db_run('INSERT OR IGNORE INTO facts VALUES (?, ?, ?)',\n"
  "               key, functor, arity != null ? arity : 0);\n"
  "    },\n"
  "    remove: function(key) {\n"
  "      __db_run('DELETE FROM facts WHERE term = ?', key);\n"
  "    },\n"
  "    all: function(predicates) {\n"
  "      if (predicates) {\n"
  "        var rows = [], keys = Object.keys(predicates);\n"
  "        for (var i = 0; i < keys.length; i++) {\n"
  "          var parts = keys[i].split('/');\n"
  "          var matched = __db_all(\n"
  "            'SELECT term FROM facts WHERE functor = ? AND arity = ?',\n"
  "            parts[0], parseInt(parts[1], 10));\n"
  "          for (var j = 0; j < matched.length; j++) rows.push(matched[j]);\n"
  "        }\n"
  "        return rows;\n"
  "      }\n"
  "      return __db_all('SELECT term FROM facts');\n"
  "    },\n"
  "    commit: function() {},\n"
  "    close: function() {}\n"
  "  };\n"
  "  persist(_engine, _adapter);\n"
  "  _persisted = true;\n"
  "}\n"
  "\n"
  "function _wyatt_load(text) {\n"
  "  return loadString(_engine, text);\n"
  "}\n"
  "\n"
  "function _wyatt_query(goal_text) {\n"
  "  var goal = parseTerm(goal_text);\n"
  "  if (!goal) return null;\n"
  "  var r = _engine.queryFirst(goal);\n"
  "  if (!r) return null;\n"
  "  return termToString(r);\n"
  "}\n"
  "\n"
  "function _wyatt_query_all(goal_text, limit) {\n"
  "  var goal = parseTerm(goal_text);\n"
  "  if (!goal) return '[]';\n"
  "  var results = _engine.query(goal, limit || 50);\n"
  "  var out = [];\n"
  "  for (var i = 0; i < results.length; i++) out.push(termToString(results[i]));\n"
  "  return JSON.stringify(out);\n"
  "}\n"
  "\n"
  "function _wyatt_exec(goal_text) {\n"
  "  var goal = parseTerm(goal_text);\n"
  "  if (!goal) return false;\n"
  "  return _engine.queryFirst(goal) !== null;\n"
  "}\n"
  "\n"
  "function _wyatt_fossilize() {\n"
  "  return fossilize(_engine);\n"
  "}\n";

/* ── Public API ──────────────────────────────────────────── */

wyatt_t *wyatt_open(const char *db_path) {
    wyatt_t *w = calloc(1, sizeof(*w));
    if (!w) return NULL;

    w->result_cap = 1024;
    w->result_buf = malloc(w->result_cap);

    /* QuickJS */
    w->rt = JS_NewRuntime();
    w->ctx = JS_NewContext(w->rt);
    JS_SetContextOpaque(w->ctx, w);

    /* Expose SQLite bindings as globals */
    JSValue global = JS_GetGlobalObject(w->ctx);
    JS_SetPropertyStr(w->ctx, global, "__db_exec",
        JS_NewCFunction(w->ctx, js_db_exec, "__db_exec", 1));
    JS_SetPropertyStr(w->ctx, global, "__db_run",
        JS_NewCFunction(w->ctx, js_db_run, "__db_run", 4));
    JS_SetPropertyStr(w->ctx, global, "__db_all",
        JS_NewCFunction(w->ctx, js_db_all, "__db_all", 3));
    JS_SetPropertyStr(w->ctx, global, "__db_commit",
        JS_NewCFunction(w->ctx, js_db_commit, "__db_commit", 0));

    /* Also expose termToString + parseTerm from parser */
    JS_FreeValue(w->ctx, global);

    /* Load embedded Y@ modules (order matters) */
    if (eval_embedded(w, js_reactive_src, "reactive.js") < 0) goto fail;
    if (eval_embedded(w, js_prolog_engine_src, "prolog-engine.js") < 0) goto fail;
    if (eval_embedded(w, js_parser_src, "parser.js") < 0) goto fail;
    if (eval_embedded(w, js_load_string_src, "loadString") < 0) goto fail;
    if (eval_embedded(w, js_reactive_prolog_src, "reactive-prolog.js") < 0) goto fail;
    if (eval_embedded(w, js_qjson_src, "qjson.js") < 0) goto fail;
    if (eval_embedded(w, js_persist_src, "persist.js") < 0) goto fail;
    if (eval_embedded(w, js_fossilize_src, "fossilize.js") < 0) goto fail;

    /* Bootstrap: create engine + helpers */
    if (eval_embedded(w, js_bootstrap, "bootstrap") < 0) goto fail;

    /* SQLite (optional) */
    if (db_path) {
        if (sqlite3_open(db_path, &w->db) != SQLITE_OK) {
            set_error(w, sqlite3_errmsg(w->db));
            sqlite3_close(w->db);
            w->db = NULL;
        } else {
            sqlite3_exec(w->db, "PRAGMA journal_mode=WAL", NULL, NULL, NULL);
            /* Wire persist adapter */
            if (eval_embedded(w, "_wyatt_setup_persist();", "persist-init") < 0) goto fail;
        }
    }

    return w;

fail:
    wyatt_close(w);
    return NULL;
}

void wyatt_close(wyatt_t *w) {
    if (!w) return;
    if (w->db) sqlite3_close(w->db);
    if (w->ctx) JS_FreeContext(w->ctx);
    if (w->rt) JS_FreeRuntime(w->rt);
    free(w->result_buf);
    free(w);
}

int wyatt_load(wyatt_t *w, const char *prolog_text) {
    clear_error(w);
    /* Escape the text for JS string */
    size_t len = strlen(prolog_text);
    size_t buf_size = len * 2 + 64;
    char *js = malloc(buf_size);
    if (!js) { set_error(w, "out of memory"); return -1; }

    char *p = js;
    p += sprintf(p, "_wyatt_load(\"");
    for (size_t i = 0; i < len; i++) {
        char c = prolog_text[i];
        if (c == '"') { *p++ = '\\'; *p++ = '"'; }
        else if (c == '\\') { *p++ = '\\'; *p++ = '\\'; }
        else if (c == '\n') { *p++ = '\\'; *p++ = 'n'; }
        else if (c == '\r') { *p++ = '\\'; *p++ = 'r'; }
        else *p++ = c;
    }
    p += sprintf(p, "\")");

    JSValue r = JS_Eval(w->ctx, js, p - js, "load", JS_EVAL_TYPE_GLOBAL);
    free(js);

    if (check_exception(w, r)) { JS_FreeValue(w->ctx, r); return -1; }
    int32_t count = 0;
    JS_ToInt32(w->ctx, &count, r);
    JS_FreeValue(w->ctx, r);
    return count;
}

const char *wyatt_query(wyatt_t *w, const char *goal_text) {
    clear_error(w);
    size_t len = strlen(goal_text);
    size_t buf_size = len * 2 + 64;
    char *js = malloc(buf_size);
    if (!js) { set_error(w, "out of memory"); return NULL; }

    char *p = js;
    p += sprintf(p, "_wyatt_query(\"");
    for (size_t i = 0; i < len; i++) {
        char c = goal_text[i];
        if (c == '"') { *p++ = '\\'; *p++ = '"'; }
        else if (c == '\\') { *p++ = '\\'; *p++ = '\\'; }
        else *p++ = c;
    }
    p += sprintf(p, "\")");

    JSValue r = JS_Eval(w->ctx, js, p - js, "query", JS_EVAL_TYPE_GLOBAL);
    free(js);

    if (check_exception(w, r)) { JS_FreeValue(w->ctx, r); return NULL; }
    if (JS_IsNull(r) || JS_IsUndefined(r)) { JS_FreeValue(w->ctx, r); return NULL; }

    const char *s = JS_ToCString(w->ctx, r);
    if (s) {
        set_result(w, s);
        JS_FreeCString(w->ctx, s);
    }
    JS_FreeValue(w->ctx, r);
    return s ? w->result_buf : NULL;
}

const char *wyatt_query_all(wyatt_t *w, const char *goal_text, int limit) {
    clear_error(w);
    size_t len = strlen(goal_text);
    char *js = malloc(len * 2 + 80);
    if (!js) { set_error(w, "out of memory"); return NULL; }

    char *p = js;
    p += sprintf(p, "_wyatt_query_all(\"");
    for (size_t i = 0; i < len; i++) {
        char c = goal_text[i];
        if (c == '"') { *p++ = '\\'; *p++ = '"'; }
        else if (c == '\\') { *p++ = '\\'; *p++ = '\\'; }
        else *p++ = c;
    }
    p += sprintf(p, "\", %d)", limit > 0 ? limit : 50);

    JSValue r = JS_Eval(w->ctx, js, p - js, "query_all", JS_EVAL_TYPE_GLOBAL);
    free(js);

    if (check_exception(w, r)) { JS_FreeValue(w->ctx, r); return NULL; }
    const char *s = JS_ToCString(w->ctx, r);
    if (s) {
        set_result(w, s);
        JS_FreeCString(w->ctx, s);
    }
    JS_FreeValue(w->ctx, r);
    return s ? w->result_buf : NULL;
}

int wyatt_exec(wyatt_t *w, const char *goal_text) {
    clear_error(w);
    size_t len = strlen(goal_text);
    char *js = malloc(len * 2 + 64);
    if (!js) { set_error(w, "out of memory"); return 0; }

    char *p = js;
    p += sprintf(p, "_wyatt_exec(\"");
    for (size_t i = 0; i < len; i++) {
        char c = goal_text[i];
        if (c == '"') { *p++ = '\\'; *p++ = '"'; }
        else if (c == '\\') { *p++ = '\\'; *p++ = '\\'; }
        else *p++ = c;
    }
    p += sprintf(p, "\")");

    JSValue r = JS_Eval(w->ctx, js, p - js, "exec", JS_EVAL_TYPE_GLOBAL);
    free(js);

    if (check_exception(w, r)) { JS_FreeValue(w->ctx, r); return 0; }
    int ok = JS_ToBool(w->ctx, r);
    JS_FreeValue(w->ctx, r);
    return ok;
}

int wyatt_fossilize(wyatt_t *w) {
    clear_error(w);
    JSValue r = JS_Eval(w->ctx, "_wyatt_fossilize()", 20, "fossilize",
                        JS_EVAL_TYPE_GLOBAL);
    if (check_exception(w, r)) { JS_FreeValue(w->ctx, r); return -1; }
    int32_t boundary = 0;
    JS_ToInt32(w->ctx, &boundary, r);
    JS_FreeValue(w->ctx, r);
    return boundary;
}

const char *wyatt_error(wyatt_t *w) {
    return w->error_buf[0] ? w->error_buf : NULL;
}
