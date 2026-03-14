#!/bin/bash
# ============================================================
# build.sh — Compile SQLite to WASM via Emscripten
#
# Run inside the wasm-build container:
#   docker compose run --rm wasm-build
#
# Output:  /out/sqlite3.js    (Emscripten glue)
#          /out/sqlite3.wasm   (compiled binary)
#          /out/shim.js        (better-sqlite3-compatible wrapper)
# ============================================================

set -euo pipefail

echo "=== Building SQLite WASM ==="

EXPORTED='[
  "_wasm_db_open",
  "_wasm_db_close",
  "_wasm_db_exec",
  "_wasm_db_errmsg",
  "_wasm_db_prepare",
  "_wasm_db_key",
  "_wasm_stmt_finalize",
  "_wasm_stmt_reset",
  "_wasm_stmt_step",
  "_wasm_stmt_run",
  "_wasm_stmt_bind_text",
  "_wasm_stmt_bind_int",
  "_wasm_stmt_bind_double",
  "_wasm_stmt_bind_null",
  "_wasm_stmt_columns",
  "_wasm_stmt_colname",
  "_wasm_stmt_coltype",
  "_wasm_stmt_int",
  "_wasm_stmt_double",
  "_wasm_stmt_text",
  "_malloc",
  "_free"
]'

RUNTIME='[
  "cwrap",
  "UTF8ToString",
  "stringToUTF8",
  "lengthBytesUTF8"
]'

# Copy amalgamation next to wrapper
cp /build/sqlite/sqlite3.c /build/src/sqlite3.c
cp /build/sqlite/sqlite3.h /build/src/sqlite3.h

emcc /build/src/wyatt_wasm.c \
  -I/build/src \
  -O2 \
  -DSQLITE_OMIT_LOAD_EXTENSION \
  -DSQLITE_THREADSAFE=0 \
  -DSQLITE_ENABLE_FTS5 \
  -DSQLITE_ENABLE_JSON1 \
  -DSQLITE_DQS=0 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" \
  -s EXPORTED_RUNTIME_METHODS="$RUNTIME" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="initSqlite" \
  -s ENVIRONMENT='web,worker,node' \
  -s FILESYSTEM=0 \
  -o /out/sqlite3.js

# Copy shim alongside
cp /build/src/shim.js /out/shim.js

echo ""
echo "=== Output ==="
ls -lh /out/
echo ""
echo "Done."
