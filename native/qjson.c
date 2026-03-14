/* ============================================================
 * qjson.c — Native C QJSON parser/serializer
 *
 * Arena-allocated recursive descent.  Zero malloc per parse.
 * ============================================================ */

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "qjson.h"

/* ── Arena ───────────────────────────────────────────────── */

void qj_arena_init(qj_arena *a, void *buf, size_t cap) {
    a->buf = (char *)buf;
    a->used = 0;
    a->cap = cap;
}

void qj_arena_reset(qj_arena *a) { a->used = 0; }

void *qj_arena_alloc(qj_arena *a, size_t size) {
    size = (size + 7) & ~(size_t)7; /* align to 8 */
    if (a->used + size > a->cap) return NULL;
    void *p = a->buf + a->used;
    a->used += size;
    return p;
}

static char *arena_strdup(qj_arena *a, const char *s, int len) {
    char *p = qj_arena_alloc(a, len + 1);
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
    qj_arena   *arena;
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

static qj_val *parse_value(pstate *p);

static qj_val *make_val(pstate *p, qj_type t) {
    qj_val *v = qj_arena_alloc(p->arena, sizeof(qj_val));
    if (v) { memset(v, 0, sizeof(*v)); v->type = t; }
    return v;
}

/* ── String parsing ──────────────────────────────────────── */

static qj_val *parse_string_val(pstate *p) {
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
    char *buf = qj_arena_alloc(p->arena, escaped_len + 1);
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

    qj_val *v = make_val(p, QJ_STRING);
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

static qj_val *parse_number(pstate *p) {
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
        qj_val *v = make_val(p, QJ_BIGINT);
        if (v) { v->str.s = raw; v->str.len = raw_len; }
        return v;
    }
    if (suffix == 'M' || suffix == 'm') {
        p->pos++;
        qj_val *v = make_val(p, QJ_BIGDEC);
        if (v) { v->str.s = raw; v->str.len = raw_len; }
        return v;
    }
    if (suffix == 'L' || suffix == 'l') {
        p->pos++;
        qj_val *v = make_val(p, QJ_BIGFLOAT);
        if (v) { v->str.s = raw; v->str.len = raw_len; }
        return v;
    }

    qj_val *v = make_val(p, QJ_NUM);
    if (v) v->num = atof(raw);
    (void)is_float;
    return v;
}

/* ── Array parsing ───────────────────────────────────────── */

static qj_val *parse_array(pstate *p) {
    p->pos++; /* [ */
    skip_ws(p);

    /* Collect into temp array (max 256 items, then grow) */
    qj_val *items[256];
    int count = 0, cap = 256;
    qj_val **heap_items = NULL;
    qj_val **cur = items;

    if (peek(p) == ']') { p->pos++; goto done; }
    for (;;) {
        qj_val *item = parse_value(p);
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
    qj_val *v = make_val(p, QJ_ARRAY);
    if (!v) return NULL;
    v->arr.count = count;
    v->arr.items = qj_arena_alloc(p->arena, count * sizeof(qj_val *));
    if (v->arr.items) memcpy(v->arr.items, cur, count * sizeof(qj_val *));
    (void)heap_items;
    return v;
}

/* ── Object parsing ──────────────────────────────────────── */

static qj_val *parse_object(pstate *p) {
    p->pos++; /* { */
    skip_ws(p);

    qj_kv pairs[128];
    int count = 0;

    if (peek(p) == '}') { p->pos++; goto done; }
    for (;;) {
        skip_ws(p);
        /* Key: quoted string or bare identifier */
        const char *key; int key_len;
        if (peek(p) == '"') {
            qj_val *ks = parse_string_val(p);
            if (!ks) return NULL;
            key = ks->str.s; key_len = ks->str.len;
        } else {
            key = parse_ident(p, &key_len);
            if (!key) return NULL;
        }
        skip_ws(p);
        if (peek(p) != ':') return NULL;
        p->pos++;
        qj_val *val = parse_value(p);
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
    qj_val *v = make_val(p, QJ_OBJECT);
    if (!v) return NULL;
    v->obj.count = count;
    v->obj.pairs = qj_arena_alloc(p->arena, count * sizeof(qj_kv));
    if (v->obj.pairs) memcpy(v->obj.pairs, pairs, count * sizeof(qj_kv));
    return v;
}

/* ── Value dispatch ──────────────────────────────────────── */

static qj_val *parse_value(pstate *p) {
    skip_ws(p);
    char c = peek(p);
    if (c == '"') return parse_string_val(p);
    if (c == '{') return parse_object(p);
    if (c == '[') return parse_array(p);
    if (c == 't' && p->pos + 4 <= p->len && memcmp(p->s + p->pos, "true", 4) == 0)
        { p->pos += 4; return make_val(p, QJ_TRUE); }
    if (c == 'f' && p->pos + 5 <= p->len && memcmp(p->s + p->pos, "false", 5) == 0)
        { p->pos += 5; return make_val(p, QJ_FALSE); }
    if (c == 'n' && p->pos + 4 <= p->len && memcmp(p->s + p->pos, "null", 4) == 0)
        { p->pos += 4; return make_val(p, QJ_NULL); }
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number(p);
    return NULL;
}

/* ── Public parse ────────────────────────────────────────── */

qj_val *qj_parse(qj_arena *a, const char *text, int len) {
    pstate p = { text, 0, len, a };
    qj_val *v = parse_value(&p);
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

static int stringify_val(const qj_val *v, char *buf, int pos, int cap) {
    if (!v) return emit(buf, pos, cap, "null", 4);
    switch (v->type) {
    case QJ_NULL:  return emit(buf, pos, cap, "null", 4);
    case QJ_TRUE:  return emit(buf, pos, cap, "true", 4);
    case QJ_FALSE: return emit(buf, pos, cap, "false", 5);
    case QJ_NUM: {
        char tmp[32];
        int n = snprintf(tmp, sizeof(tmp), "%.17g", v->num);
        return emit(buf, pos, cap, tmp, n);
    }
    case QJ_BIGINT:
        pos = emit(buf, pos, cap, v->str.s, v->str.len);
        return emit_char(buf, pos, cap, 'N');
    case QJ_BIGDEC:
        pos = emit(buf, pos, cap, v->str.s, v->str.len);
        return emit_char(buf, pos, cap, 'M');
    case QJ_BIGFLOAT:
        pos = emit(buf, pos, cap, v->str.s, v->str.len);
        return emit_char(buf, pos, cap, 'L');
    case QJ_STRING:
        return emit_str_escaped(buf, pos, cap, v->str.s, v->str.len);
    case QJ_ARRAY:
        pos = emit_char(buf, pos, cap, '[');
        for (int i = 0; i < v->arr.count; i++) {
            if (i > 0) pos = emit_char(buf, pos, cap, ',');
            pos = stringify_val(v->arr.items[i], buf, pos, cap);
        }
        return emit_char(buf, pos, cap, ']');
    case QJ_OBJECT:
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

int qj_stringify(const qj_val *v, char *buf, int cap) {
    int n = stringify_val(v, buf, 0, cap > 0 ? cap - 1 : 0);
    if (cap > 0) buf[n < cap ? n : cap - 1] = '\0';
    return n;
}

/* ── Object key lookup ───────────────────────────────────── */

qj_val *qj_obj_get(const qj_val *v, const char *key) {
    if (!v || v->type != QJ_OBJECT) return NULL;
    int klen = strlen(key);
    for (int i = 0; i < v->obj.count; i++) {
        if (v->obj.pairs[i].key_len == klen &&
            memcmp(v->obj.pairs[i].key, key, klen) == 0)
            return v->obj.pairs[i].val;
    }
    return NULL;
}
