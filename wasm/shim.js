
// ============================================================
// shim.js — better-sqlite3-compatible wrapper over SQLite WASM
//
// Appended to the Emscripten output by build.sh.
// Provides: WasmDatabase(Module) with .exec(), .prepare(), .close()
//
// Usage:
//   var Module = await initSqlite();
//   var db = new WasmDatabase(Module);
//   db.exec("CREATE TABLE t (a TEXT, b REAL)");
//   db.prepare("INSERT INTO t VALUES (?, ?)").run("x", 42);
//   db.prepare("SELECT * FROM t").all(); // [{a:"x", b:42}]
// ============================================================

function WasmDatabase(Module) {
  var api = {
    open:         Module.cwrap("wasm_db_open",        "number",  []),
    close:        Module.cwrap("wasm_db_close",       null,      ["number"]),
    exec:         Module.cwrap("wasm_db_exec",        "number",  ["number", "string"]),
    errmsg:       Module.cwrap("wasm_db_errmsg",      "string",  ["number"]),
    prepare:      Module.cwrap("wasm_db_prepare",     "number",  ["number", "string"]),
    key:          Module.cwrap("wasm_db_key",         "number",  ["number", "string"]),
    finalize:     Module.cwrap("wasm_stmt_finalize",  null,      ["number"]),
    reset:        Module.cwrap("wasm_stmt_reset",     null,      ["number"]),
    step:         Module.cwrap("wasm_stmt_step",      "number",  ["number"]),
    run:          Module.cwrap("wasm_stmt_run",       null,      ["number"]),
    bind_text:    Module.cwrap("wasm_stmt_bind_text",   null,    ["number", "number", "string"]),
    bind_int:     Module.cwrap("wasm_stmt_bind_int",    null,    ["number", "number", "number"]),
    bind_double:  Module.cwrap("wasm_stmt_bind_double", null,    ["number", "number", "number"]),
    bind_null:    Module.cwrap("wasm_stmt_bind_null",   null,    ["number", "number"]),
    columns:      Module.cwrap("wasm_stmt_columns",   "number",  ["number"]),
    colname:      Module.cwrap("wasm_stmt_colname",   "string",  ["number", "number"]),
    coltype:      Module.cwrap("wasm_stmt_coltype",   "number",  ["number", "number"]),
    col_int:      Module.cwrap("wasm_stmt_int",       "number",  ["number", "number"]),
    col_double:   Module.cwrap("wasm_stmt_double",    "number",  ["number", "number"]),
    col_text:     Module.cwrap("wasm_stmt_text",      "string",  ["number", "number"])
  };

  var db = api.open();
  var stmtCache = {};

  function _bind(stmt, args) {
    api.reset(stmt);
    for (var i = 0; i < args.length; i++) {
      var v = args[i];
      var idx = i + 1;
      if (v === null || v === undefined) {
        api.bind_null(stmt, idx);
      } else if (typeof v === "number") {
        if (v === (v | 0) && v >= -2147483648 && v <= 2147483647) {
          api.bind_int(stmt, idx, v);
        } else {
          api.bind_double(stmt, idx, v);
        }
      } else {
        api.bind_text(stmt, idx, String(v));
      }
    }
  }

  function _readRow(stmt) {
    var n = api.columns(stmt);
    var row = {};
    for (var c = 0; c < n; c++) {
      var name = api.colname(stmt, c);
      var type = api.coltype(stmt, c);
      if      (type === 1) row[name] = api.col_int(stmt, c);
      else if (type === 2) row[name] = api.col_double(stmt, c);
      else if (type === 3) row[name] = api.col_text(stmt, c);
      else                 row[name] = null;
    }
    return row;
  }

  this.exec = function(sql) {
    var rc = api.exec(db, sql);
    if (rc !== 0) throw new Error("SQLite error: " + api.errmsg(db));
  };

  this.prepare = function(sql) {
    if (stmtCache[sql]) {
      api.reset(stmtCache[sql]);
      return _wrapStmt(stmtCache[sql]);
    }
    var stmt = api.prepare(db, sql);
    if (!stmt) throw new Error("Prepare failed: " + api.errmsg(db));
    stmtCache[sql] = stmt;
    return _wrapStmt(stmt);
  };

  function _wrapStmt(stmt) {
    return {
      run: function() {
        _bind(stmt, Array.prototype.slice.call(arguments));
        api.run(stmt);
      },
      all: function() {
        _bind(stmt, Array.prototype.slice.call(arguments));
        var rows = [];
        while (api.step(stmt)) rows.push(_readRow(stmt));
        api.reset(stmt);
        return rows;
      }
    };
  }

  this.close = function() {
    for (var sql in stmtCache) api.finalize(stmtCache[sql]);
    stmtCache = {};
    api.close(db);
  };

  // SQLCipher: set encryption key (no-op without -DSQLITE_HAS_CODEC)
  this.pragma = function(pragma) {
    var m = pragma.match(/^key\s*=\s*'(.+)'$/);
    if (m) { api.key(db, m[1]); return; }
    api.exec(db, "PRAGMA " + pragma);
  };
}

// Export for both browser and Node
if (typeof module !== "undefined" && module.exports) {
  module.exports.initSqlite = initSqlite;
  module.exports.WasmDatabase = WasmDatabase;
}
