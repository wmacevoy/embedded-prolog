/* ============================================================
 * y8_qjson.c — y8 (Wyatt) native C API: QJSON + interval projection
 *
 * Arena-allocated recursive descent.  Zero malloc per parse.
 * ============================================================ */

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <fenv.h>
#include <math.h>
#include <float.h>
#include "y8_qjson.h"

#pragma STDC FENV_ACCESS ON

/* ── Arena ───────────────────────────────────────────────── */

void y8_arena_init(y8_arena *a, void *buf, size_t cap) {
    a->buf = (char *)buf;
    a->used = 0;
    a->cap = cap;
}

void y8_arena_reset(y8_arena *a) { a->used = 0; }

void *y8_arena_alloc(y8_arena *a, size_t size) {
    size = (size + 7) & ~(size_t)7; /* align to 8 */
    if (a->used + size > a->cap) return NULL;
    void *p = a->buf + a->used;
    a->used += size;
    return p;
}

static char *arena_strdup(y8_arena *a, const char *s, int len) {
    char *p = y8_arena_alloc(a, len + 1);
    if (!p) return NULL;
    memcpy(p, s, len);
    p[len] = '\0';
    return p;
}

/* ── Parser state ────────────────────────────────────────── */

typedef struct {
    const char *s;
    int         pos;
    int         len;
    y8_arena   *arena;
} pstate;

static char peek(pstate *p) { return p->pos < p->len ? p->s[p->pos] : 0; }

static void skip_ws(pstate *p) {
    while (p->pos < p->len) {
        char c = p->s[p->pos];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { p->pos++; continue; }
        if (c == '/' && p->pos + 1 < p->len) {
            if (p->s[p->pos + 1] == '/') {
                p->pos += 2;
                while (p->pos < p->len && p->s[p->pos] != '\n') p->pos++;
                continue;
            }
            if (p->s[p->pos + 1] == '*') {
                p->pos += 2;
                int depth = 1;
                while (p->pos + 1 < p->len && depth > 0) {
                    if (p->s[p->pos] == '/' && p->s[p->pos+1] == '*') { depth++; p->pos += 2; }
                    else if (p->s[p->pos] == '*' && p->s[p->pos+1] == '/') { depth--; p->pos += 2; }
                    else p->pos++;
                }
                continue;
            }
        }
        break;
    }
}

static y8_val *parse_value(pstate *p);

static y8_val *make_val(pstate *p, y8_type t) {
    y8_val *v = y8_arena_alloc(p->arena, sizeof(y8_val));
    if (v) { memset(v, 0, sizeof(*v)); v->type = t; }
    return v;
}

/* ── String parsing ──────────────────────────────────────── */

static y8_val *parse_string_val(pstate *p) {
    p->pos++; /* skip opening " */
    /* First pass: compute length */
    int start = p->pos, escaped_len = 0;
    while (p->pos < p->len && p->s[p->pos] != '"') {
        if (p->s[p->pos] == '\\') { p->pos++; }
        p->pos++;
        escaped_len++;
    }
    if (p->pos >= p->len) return NULL;
    int raw_end = p->pos;
    p->pos++; /* skip closing " */

    /* Second pass: unescape */
    char *buf = y8_arena_alloc(p->arena, escaped_len + 1);
    if (!buf) return NULL;
    int out = 0, i = start;
    while (i < raw_end) {
        if (p->s[i] == '\\') {
            i++;
            switch (p->s[i]) {
                case '"':  buf[out++] = '"'; break;
                case '\\': buf[out++] = '\\'; break;
                case '/':  buf[out++] = '/'; break;
                case 'b':  buf[out++] = '\b'; break;
                case 'f':  buf[out++] = '\f'; break;
                case 'n':  buf[out++] = '\n'; break;
                case 'r':  buf[out++] = '\r'; break;
                case 't':  buf[out++] = '\t'; break;
                case 'u':  /* simplified: ASCII only */
                    buf[out++] = '?'; i += 4; break;
                default:   buf[out++] = p->s[i]; break;
            }
        } else {
            buf[out++] = p->s[i];
        }
        i++;
    }
    buf[out] = '\0';

    y8_val *v = make_val(p, Y8_STRING);
    if (v) { v->str.s = buf; v->str.len = out; }
    return v;
}

/* Parse bare identifier (unquoted key) */
static char *parse_ident(pstate *p, int *out_len) {
    int start = p->pos;
    char c = peek(p);
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'))
        return NULL;
    p->pos++;
    while (p->pos < p->len) {
        c = p->s[p->pos];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '$') p->pos++;
        else break;
    }
    int len = p->pos - start;
    *out_len = len;
    return arena_strdup(p->arena, p->s + start, len);
}

/* ── Number parsing ──────────────────────────────────────── */

static y8_val *parse_number(pstate *p) {
    int start = p->pos;
    if (peek(p) == '-') p->pos++;
    while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') p->pos++;
    int is_float = 0;
    if (p->pos < p->len && p->s[p->pos] == '.') {
        is_float = 1; p->pos++;
        while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') p->pos++;
    }
    if (p->pos < p->len && (p->s[p->pos] == 'e' || p->s[p->pos] == 'E')) {
        is_float = 1; p->pos++;
        if (p->pos < p->len && (p->s[p->pos] == '+' || p->s[p->pos] == '-')) p->pos++;
        while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') p->pos++;
    }
    int raw_len = p->pos - start;
    char *raw = arena_strdup(p->arena, p->s + start, raw_len);

    /* Check suffix */
    char suffix = (p->pos < p->len) ? p->s[p->pos] : 0;
    if (suffix == 'N' || suffix == 'n') {
        p->pos++;
        y8_val *v = make_val(p, Y8_BIGINT);
        if (v) { v->str.s = raw; v->str.len = raw_len; }
        return v;
    }
    if (suffix == 'M' || suffix == 'm') {
        p->pos++;
        y8_val *v = make_val(p, Y8_BIGDEC);
        if (v) { v->str.s = raw; v->str.len = raw_len; }
        return v;
    }
    if (suffix == 'L' || suffix == 'l') {
        p->pos++;
        y8_val *v = make_val(p, Y8_BIGFLOAT);
        if (v) { v->str.s = raw; v->str.len = raw_len; }
        return v;
    }

    y8_val *v = make_val(p, Y8_NUM);
    if (v) v->num = atof(raw);
    (void)is_float;
    return v;
}

/* ── Array parsing ───────────────────────────────────────── */

static y8_val *parse_array(pstate *p) {
    p->pos++; /* [ */
    skip_ws(p);

    /* Collect into temp array (max 256 items, then grow) */
    y8_val *items[256];
    int count = 0, cap = 256;
    y8_val **heap_items = NULL;
    y8_val **cur = items;

    if (peek(p) == ']') { p->pos++; goto done; }
    for (;;) {
        y8_val *item = parse_value(p);
        if (!item) return NULL;
        if (count >= cap) {
            /* Overflow stack — shouldn't happen for typical messages */
            return NULL;
        }
        cur[count++] = item;
        skip_ws(p);
        if (peek(p) == ']') { p->pos++; break; }
        if (peek(p) != ',') return NULL;
        p->pos++;
        skip_ws(p);
        if (peek(p) == ']') { p->pos++; break; } /* trailing comma */
    }

done:;
    y8_val *v = make_val(p, Y8_ARRAY);
    if (!v) return NULL;
    v->arr.count = count;
    v->arr.items = y8_arena_alloc(p->arena, count * sizeof(y8_val *));
    if (v->arr.items) memcpy(v->arr.items, cur, count * sizeof(y8_val *));
    (void)heap_items;
    return v;
}

/* ── Object parsing ──────────────────────────────────────── */

static y8_val *parse_object(pstate *p) {
    p->pos++; /* { */
    skip_ws(p);

    y8_kv pairs[128];
    int count = 0;

    if (peek(p) == '}') { p->pos++; goto done; }
    for (;;) {
        skip_ws(p);
        /* Key: quoted string or bare identifier */
        const char *key; int key_len;
        if (peek(p) == '"') {
            y8_val *ks = parse_string_val(p);
            if (!ks) return NULL;
            key = ks->str.s; key_len = ks->str.len;
        } else {
            key = parse_ident(p, &key_len);
            if (!key) return NULL;
        }
        skip_ws(p);
        if (peek(p) != ':') return NULL;
        p->pos++;
        y8_val *val = parse_value(p);
        if (!val) return NULL;
        if (count < 128) {
            pairs[count].key = key;
            pairs[count].key_len = key_len;
            pairs[count].val = val;
            count++;
        }
        skip_ws(p);
        if (peek(p) == '}') { p->pos++; break; }
        if (peek(p) != ',') return NULL;
        p->pos++;
        skip_ws(p);
        if (peek(p) == '}') { p->pos++; break; } /* trailing comma */
    }

done:;
    y8_val *v = make_val(p, Y8_OBJECT);
    if (!v) return NULL;
    v->obj.count = count;
    v->obj.pairs = y8_arena_alloc(p->arena, count * sizeof(y8_kv));
    if (v->obj.pairs) memcpy(v->obj.pairs, pairs, count * sizeof(y8_kv));
    return v;
}

/* ── Value dispatch ──────────────────────────────────────── */

static y8_val *parse_value(pstate *p) {
    skip_ws(p);
    char c = peek(p);
    if (c == '"') return parse_string_val(p);
    if (c == '{') return parse_object(p);
    if (c == '[') return parse_array(p);
    if (c == 't' && p->pos + 4 <= p->len && memcmp(p->s + p->pos, "true", 4) == 0)
        { p->pos += 4; return make_val(p, Y8_TRUE); }
    if (c == 'f' && p->pos + 5 <= p->len && memcmp(p->s + p->pos, "false", 5) == 0)
        { p->pos += 5; return make_val(p, Y8_FALSE); }
    if (c == 'n' && p->pos + 4 <= p->len && memcmp(p->s + p->pos, "null", 4) == 0)
        { p->pos += 4; return make_val(p, Y8_NULL); }
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number(p);
    return NULL;
}

/* ── Public parse ────────────────────────────────────────── */

y8_val *y8_parse(y8_arena *a, const char *text, int len) {
    pstate p = { text, 0, len, a };
    y8_val *v = parse_value(&p);
    skip_ws(&p);
    return v;
}

/* ── Stringify ───────────────────────────────────────────── */

static int emit(char *buf, int pos, int cap, const char *s, int len) {
    if (pos + len <= cap) memcpy(buf + pos, s, len);
    return pos + len;
}

static int emit_char(char *buf, int pos, int cap, char c) {
    if (pos < cap) buf[pos] = c;
    return pos + 1;
}

static int emit_str_escaped(char *buf, int pos, int cap, const char *s, int len) {
    pos = emit_char(buf, pos, cap, '"');
    for (int i = 0; i < len; i++) {
        char c = s[i];
        if (c == '"')       { pos = emit(buf, pos, cap, "\\\"", 2); }
        else if (c == '\\') { pos = emit(buf, pos, cap, "\\\\", 2); }
        else if (c == '\n') { pos = emit(buf, pos, cap, "\\n", 2); }
        else if (c == '\r') { pos = emit(buf, pos, cap, "\\r", 2); }
        else if (c == '\t') { pos = emit(buf, pos, cap, "\\t", 2); }
        else                { pos = emit_char(buf, pos, cap, c); }
    }
    pos = emit_char(buf, pos, cap, '"');
    return pos;
}

static int stringify_val(const y8_val *v, char *buf, int pos, int cap) {
    if (!v) return emit(buf, pos, cap, "null", 4);
    switch (v->type) {
    case Y8_NULL:  return emit(buf, pos, cap, "null", 4);
    case Y8_TRUE:  return emit(buf, pos, cap, "true", 4);
    case Y8_FALSE: return emit(buf, pos, cap, "false", 5);
    case Y8_NUM: {
        char tmp[32];
        int n = snprintf(tmp, sizeof(tmp), "%.17g", v->num);
        return emit(buf, pos, cap, tmp, n);
    }
    case Y8_BIGINT:
        pos = emit(buf, pos, cap, v->str.s, v->str.len);
        return emit_char(buf, pos, cap, 'N');
    case Y8_BIGDEC:
        pos = emit(buf, pos, cap, v->str.s, v->str.len);
        return emit_char(buf, pos, cap, 'M');
    case Y8_BIGFLOAT:
        pos = emit(buf, pos, cap, v->str.s, v->str.len);
        return emit_char(buf, pos, cap, 'L');
    case Y8_STRING:
        return emit_str_escaped(buf, pos, cap, v->str.s, v->str.len);
    case Y8_ARRAY:
        pos = emit_char(buf, pos, cap, '[');
        for (int i = 0; i < v->arr.count; i++) {
            if (i > 0) pos = emit_char(buf, pos, cap, ',');
            pos = stringify_val(v->arr.items[i], buf, pos, cap);
        }
        return emit_char(buf, pos, cap, ']');
    case Y8_OBJECT:
        pos = emit_char(buf, pos, cap, '{');
        for (int i = 0; i < v->obj.count; i++) {
            if (i > 0) pos = emit_char(buf, pos, cap, ',');
            pos = emit_str_escaped(buf, pos, cap, v->obj.pairs[i].key, v->obj.pairs[i].key_len);
            pos = emit_char(buf, pos, cap, ':');
            pos = stringify_val(v->obj.pairs[i].val, buf, pos, cap);
        }
        return emit_char(buf, pos, cap, '}');
    }
    return pos;
}

int y8_stringify(const y8_val *v, char *buf, int cap) {
    int n = stringify_val(v, buf, 0, cap > 0 ? cap - 1 : 0);
    if (cap > 0) buf[n < cap ? n : cap - 1] = '\0';
    return n;
}

/* ── Object key lookup ───────────────────────────────────── */

y8_val *y8_obj_get(const y8_val *v, const char *key) {
    if (!v || v->type != Y8_OBJECT) return NULL;
    int klen = strlen(key);
    for (int i = 0; i < v->obj.count; i++) {
        if (v->obj.pairs[i].key_len == klen &&
            memcmp(v->obj.pairs[i].key, key, klen) == 0)
            return v->obj.pairs[i].val;
    }
    return NULL;
}

/* ── Interval projection ────────────────────────────────── */

void y8_project(const char *raw, int len, double *lo, double *hi) {
    char buf[320];
    if (len >= (int)sizeof(buf)) len = (int)sizeof(buf) - 1;
    memcpy(buf, raw, len);
    buf[len] = '\0';

    int saved = fegetround();

    fesetround(FE_DOWNWARD);
    volatile double vlo = strtod(buf, NULL);

    fesetround(FE_UPWARD);
    volatile double vhi = strtod(buf, NULL);

    fesetround(saved);
    *lo = vlo;
    *hi = vhi;
}

void y8_val_project(const y8_val *v, double *lo, double *hi) {
    if (!v) { *lo = *hi = 0; return; }
    switch (v->type) {
    case Y8_NUM:
        *lo = *hi = v->num;
        return;
    case Y8_BIGINT:
    case Y8_BIGDEC:
    case Y8_BIGFLOAT:
        y8_project(v->str.s, v->str.len, lo, hi);
        return;
    default:
        *lo = *hi = 0;
        return;
    }
}

/* ── Decimal string comparison ──────────────────────────── */

static int abs_decimal_cmp(const char *a, int al, const char *b, int bl) {
    /* Find decimal points */
    int a_dot = -1, b_dot = -1;
    for (int i = 0; i < al; i++) if (a[i] == '.') { a_dot = i; break; }
    for (int i = 0; i < bl; i++) if (b[i] == '.') { b_dot = i; break; }

    int a_int_len = a_dot >= 0 ? a_dot : al;
    int b_int_len = b_dot >= 0 ? b_dot : bl;

    /* Skip leading zeros */
    int ai = 0, bi = 0;
    while (ai < a_int_len && a[ai] == '0') ai++;
    while (bi < b_int_len && b[bi] == '0') bi++;

    int a_sig = a_int_len - ai;
    int b_sig = b_int_len - bi;

    /* Compare integer part length (more digits = larger) */
    if (a_sig != b_sig) return a_sig > b_sig ? 1 : -1;

    /* Compare integer part digits */
    for (int i = 0; i < a_sig; i++) {
        if (a[ai + i] != b[bi + i])
            return a[ai + i] > b[bi + i] ? 1 : -1;
    }

    /* Integer parts equal — compare fractional digits */
    const char *af = a_dot >= 0 ? a + a_dot + 1 : "";
    int af_len = a_dot >= 0 ? al - a_dot - 1 : 0;
    const char *bf = b_dot >= 0 ? b + b_dot + 1 : "";
    int bf_len = b_dot >= 0 ? bl - b_dot - 1 : 0;

    int max_frac = af_len > bf_len ? af_len : bf_len;
    for (int i = 0; i < max_frac; i++) {
        char ac = i < af_len ? af[i] : '0';
        char bc = i < bf_len ? bf[i] : '0';
        if (ac != bc) return ac > bc ? 1 : -1;
    }

    return 0;
}

int y8_decimal_cmp(const char *a, int a_len, const char *b, int b_len) {
    int a_neg = (a_len > 0 && a[0] == '-');
    int b_neg = (b_len > 0 && b[0] == '-');
    if (a_neg && !b_neg) return -1;
    if (!a_neg && b_neg) return 1;

    int cmp = abs_decimal_cmp(
        a + a_neg, a_len - a_neg,
        b + b_neg, b_len - b_neg
    );
    return a_neg ? -cmp : cmp;
}
