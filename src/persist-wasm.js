// ============================================================
// persist-wasm.js — Bridge between WASM SQLite and persist
//
// Loads SQLite WASM, creates a WasmDatabase, returns a
// better-sqlite3-compatible object that qsqlAdapter/persist
// can use directly.
//
// Usage (browser):
//   var db = await createWasmDb("sqlite3.wasm");
//   persist(engine, qsqlAdapter(db));
//
// Usage (encrypted, when SQLCipher WASM is available):
//   var db = await createWasmDb("sqlcipher.wasm", "secret");
//
// The returned db has: .exec(sql), .prepare(sql), .close()
// Same API as better-sqlite3.  Drop-in for all persist adapters.
//
// This file uses async/await — it runs in the browser or Node 18+,
// NOT in QuickJS/Duktape (they don't have WASM).
// ============================================================

async function createWasmDb(wasmUrl, encryptionKey) {
  // Load the Emscripten module
  // initSqlite is the MODULARIZE'd factory from the WASM build
  var Module;
  if (typeof initSqlite === "function") {
    // Global (loaded via <script>)
    Module = await initSqlite({
      locateFile: function() { return wasmUrl || "sqlite3.wasm"; }
    });
  } else {
    throw new Error("initSqlite not found — load sqlite3.js first");
  }

  // WasmDatabase is appended to the WASM glue by shim.js
  if (typeof WasmDatabase !== "function") {
    throw new Error("WasmDatabase not found — load shim.js first");
  }

  var db = new WasmDatabase(Module);

  // Set encryption key if provided (SQLCipher)
  if (encryptionKey) {
    db.pragma("key = '" + encryptionKey + "'");
  }

  return db;
}

// ── Export ───────────────────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.createWasmDb = createWasmDb;
}
if (typeof window !== "undefined") {
  window.createWasmDb = createWasmDb;
}
