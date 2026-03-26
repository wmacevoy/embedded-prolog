# Plan: wyatt C engine (QuickJS + libbf + LibreSSL + SQLite)

## Context

The Datalog layer works (87 tests passing) but is implemented
twice — Python (y8_datalog.py, 500 lines) and JS (y8-datalog.js,
270 lines).  The heavy dependencies (libbf for arithmetic,
LibreSSL for crypto, SQLite for storage) are all C libraries.
Fighting that boundary with Python/JS adapters adds complexity.

QuickJS is already vendored.  It can run parser.js natively.
One C engine that embeds everything, with thin Python/JS/CLI
wrappers, is the right architecture.

## Architecture

```
wyatt C engine (shared library: libwyatt.so/.dylib)
  ├── SQLite (in-memory or file)
  │     └── qjson_ext: format, compare, select, closure
  │     └── qjson_crypto: SHA, AES, HMAC, JWT, Shamir
  │     └── qjson_solver: libbf arithmetic, constraints
  ├── QuickJS (embedded)
  │     └── parser.js (Prolog text → terms)
  │     └── native hooks (JS callbacks)
  ├── Datalog engine (C)
  │     └── assert_fact / retract / retract_all
  │     └── query (pattern match on sets)
  │     └── resolve (facts + rule compilation + closure)
  │     └── execute_body (is/2, not, comparisons, findall)
  │     └── react dispatch (on assert/retract/ephemeral)
  │     └── send buffer
  └── libbf (arithmetic projection)

Wrappers (thin FFI, ~50 lines each):
  ├── Python: ctypes or cffi
  ├── Node.js: N-API addon or child_process
  └── CLI: standalone binary (qjs main loop)
```

## C API (libwyatt.h)

```c
// Engine lifecycle
wyatt_t *wyatt_open(const char *db_path);  // ":memory:" or file
void     wyatt_close(wyatt_t *w);

// Load Prolog text (uses QuickJS to run parser.js)
int wyatt_load(wyatt_t *w, const char *prolog_text);

// Facts
int wyatt_assert(wyatt_t *w, const char *predicate, const char *args_qjson);
int wyatt_retract(wyatt_t *w, const char *predicate, const char *args_qjson);

// Query — returns QJSON array of results
char *wyatt_query(wyatt_t *w, const char *predicate, const char *pattern_qjson);

// Resolve (facts + rules + closure)
char *wyatt_resolve(wyatt_t *w, const char *predicate, const char *pattern_qjson);

// Execute body goals (for react rules)
int wyatt_execute(wyatt_t *w, const char *goals_qjson);

// Events
int wyatt_ephemeral(wyatt_t *w, const char *event_type,
                    const char *predicate, const char *fact_qjson);

// React
int wyatt_react(wyatt_t *w, const char *event_pattern,
                const char *body_goals_qjson);

// Native hooks
typedef char *(*wyatt_native_fn)(const char *args_qjson, void *ctx);
int wyatt_native(wyatt_t *w, const char *name, wyatt_native_fn fn, void *ctx);

// Send
char *wyatt_collect_sends(wyatt_t *w);

// Crypto (LibreSSL)
char *wyatt_sha256(const char *data, int len);
char *wyatt_encrypt(const char *plaintext, int len, const char *key);
char *wyatt_decrypt(const char *ciphertext, int len, const char *key);
char *wyatt_jwt_sign(const char *payload, const char *secret);
char *wyatt_jwt_verify(const char *token, const char *secret);

// Free returned strings
void wyatt_free(char *str);
```

Text in, text out.  All arguments and return values are QJSON
strings (or NULL on failure).  The engine manages memory.

## Implementation plan

### Phase 1: Core engine in C

**File: `native/wyatt.c` + `native/wyatt.h`**

Struct:
```c
typedef struct {
    sqlite3 *db;           // SQLite (with qjson_ext loaded)
    JSRuntime *rt;         // QuickJS runtime
    JSContext *ctx;         // QuickJS context
    int root_id;           // QJSON document root
    // React rules (engine-side)
    wyatt_react_rule *react_rules;
    int react_count;
    // Send buffer
    char **sends;
    int send_count;
    // Native hooks
    wyatt_native_entry *natives;
    int native_count;
} wyatt_t;
```

Open:
1. Open SQLite (in-memory or file)
2. Load qjson_ext (auto-register via sqlite3_auto_extension or load_extension)
3. Initialize QuickJS runtime
4. Load parser.js into QuickJS
5. Call qjson_sql_adapter setup (create tables)
6. Store empty root document

Assert/retract:
- Parse args via qjson_parse (C, arena-allocated)
- Build QJSON set operations via SQL INSERT/DELETE on qjson_object_item
- Fire react rules

Query:
- Build qjson_select SQL with pattern matching
- Execute, collect results
- Return as QJSON array string

Resolve:
- Query facts (same as query)
- Look up rules in .rules.<predicate>
- Compile non-recursive to SQL JOINs
- Compile recursive to WITH RECURSIVE
- UNION ALL results

Execute body:
- Walk goal list
- Dispatch builtins (is, not, assert, retract, comparisons, findall)
- For query goals: call wyatt_query internally

Load:
- Call QuickJS: `parseProgram(text)` → JS array of {head, body}
- Walk the result, call wyatt_assert/wyatt_react for each clause

### Phase 2: Build system

```makefile
CC = gcc
CFLAGS = -O2 -std=c11 -fPIC

SOURCES = native/wyatt.c \
          vendor/qjson/native/qjson.c \
          vendor/qjson/native/qjson_sqlite_ext.c \
          vendor/qjson/native/libbf/libbf.c \
          vendor/qjson/native/libbf/cutils.c \
          vendor/quickjs/quickjs.c \
          vendor/quickjs/cutils.c \
          vendor/quickjs/libregexp.c \
          vendor/quickjs/libunicode.c

LIBS = -lm -lsqlite3 -lpthread

# With crypto:
CRYPTO_SOURCES = vendor/qjson/native/qjson_crypto.c
CRYPTO_FLAGS = -DQJSON_USE_CRYPTO -I$(LIBRESSL)/include
CRYPTO_LIBS = $(LIBRESSL)/lib/libcrypto.a

libwyatt.so: $(SOURCES)
    $(CC) $(CFLAGS) -shared -DQJSON_USE_LIBBF \
        -Ivendor/qjson/native -Ivendor/qjson/native/libbf \
        -Ivendor/quickjs \
        -o $@ $^ $(LIBS)

libwyatt_crypto.so: $(SOURCES) $(CRYPTO_SOURCES)
    $(CC) $(CFLAGS) -shared -DQJSON_USE_LIBBF $(CRYPTO_FLAGS) \
        -Ivendor/qjson/native -Ivendor/qjson/native/libbf \
        -Ivendor/quickjs \
        -o $@ $^ $(LIBS) $(CRYPTO_LIBS)
```

### Phase 3: Embed parser.js

QuickJS runs parser.js at startup:
```c
// At wyatt_open:
JSValue global = JS_GetGlobalObject(ctx);
// Load parser.js source (embedded as C string or read from file)
JS_Eval(ctx, parser_js_source, strlen(parser_js_source),
        "parser.js", JS_EVAL_TYPE_MODULE);

// At wyatt_load:
JSValue result = JS_Call(ctx, parseProgram_fn, global, 1, &text_arg);
// Walk JS array → wyatt_assert / add_rule for each clause
```

parser.js is the ONLY JS code in the engine.  Everything else
is C.  QuickJS is just a parser runtime.

### Phase 4: Python wrapper

```python
# wyatt.py — thin ctypes wrapper
import ctypes

_lib = ctypes.CDLL("libwyatt.so")

class Wyatt:
    def __init__(self, db_path=":memory:"):
        self._w = _lib.wyatt_open(db_path.encode())

    def load(self, text):
        _lib.wyatt_load(self._w, text.encode())

    def assert_fact(self, pred, args):
        _lib.wyatt_assert(self._w, pred.encode(), qjson_str(args).encode())

    def query(self, pred, pattern=None):
        result = _lib.wyatt_query(self._w, pred.encode(), ...)
        return qjson_parse(result)

    def close(self):
        _lib.wyatt_close(self._w)
```

### Phase 5: Tests

The existing 87 Python tests become the spec.  Rewrite them to
call through the C engine (via ctypes wrapper) instead of
y8_datalog.py directly.  Same test logic, different backend.

### Phase 6: CLI

```c
// native/y8.c — standalone CLI
int main(int argc, char **argv) {
    wyatt_t *w = wyatt_open(argc > 1 ? argv[1] : ":memory:");
    // Interactive REPL or file execution
    // Uses QuickJS for the REPL loop
}
```

## What stays / what goes

| Current | Fate |
|---------|------|
| `y8_datalog.py` (500 lines) | Replaced by `wyatt.py` (~50 lines ctypes wrapper) |
| `y8-datalog.js` (270 lines) | Replaced by Node N-API addon (~50 lines) |
| `y8_loader.py` (270 lines) | Replaced by `wyatt_load()` (C, uses QuickJS) |
| `y8-loader.js` (95 lines) | Replaced by `wyatt_load()` |
| `parser.js` (719 lines) | **Stays** — runs inside QuickJS |
| `test_y8_datalog.py` (45 tests) | **Stays** — calls through ctypes wrapper |
| Examples (family, vending, tutorial) | **Stay** — call through wrapper |

## Dependencies (all vendored or system)

| Library | Source | Purpose |
|---------|--------|---------|
| SQLite | system `libsqlite3` or vendored | Storage |
| QuickJS | `vendor/quickjs/` | Run parser.js |
| libbf | `vendor/qjson/native/libbf/` | Arithmetic projection |
| qjson | `vendor/qjson/native/` | Format + SQL + compare |
| LibreSSL | system or vendored | Crypto (optional) |

## Verification

```bash
# Build
make libwyatt.so

# Run existing tests through C engine
python3 src/test_y8_datalog.py   # 45 tests via ctypes
python3 examples/family/test_family.py
python3 examples/vending/test_datalog.py
python3 examples/tutorial/test_datalog.py

# C test binary
make test_wyatt && ./test_wyatt  # direct C API tests
```
