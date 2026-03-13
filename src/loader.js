// ============================================================
// loader.js — Load Prolog text into a PrologEngine
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
//
// Exports: loadString, loadFile
// ============================================================

import { parseProgram } from "./parser.js";
import { createRequire as _createRequire } from "module";

var _cjsRequire = (typeof require !== "undefined")
  ? require
  : (typeof _createRequire === "function" && typeof import.meta !== "undefined")
    ? _createRequire(import.meta.url)
    : null;

// ── loadString ──────────────────────────────────────────────
// Parse text as a Prolog program and add each clause to engine.
// Returns the number of clauses loaded.

function loadString(engine, text) {
  var clauses = parseProgram(text);
  for (var i = 0; i < clauses.length; i++) {
    engine.addClause(clauses[i].head, clauses[i].body);
  }
  return clauses.length;
}

// ── loadFile ────────────────────────────────────────────────
// Read a file from disk and call loadString.
// Uses runtime detection to pick the right file-reading API.

function loadFile(engine, path) {
  var text;
  if (typeof Bun !== "undefined" && _cjsRequire) {
    text = _cjsRequire("fs").readFileSync(path, "utf-8");
  } else if (typeof Deno !== "undefined") {
    text = Deno.readTextFileSync(path);
  } else if (_cjsRequire) {
    text = _cjsRequire("fs").readFileSync(path, "utf-8");
  } else {
    throw new Error("loadFile not available in this runtime");
  }
  return loadString(engine, text);
}

// ── Export (dual ESM/CJS) ─────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.loadString = loadString;
  exports.loadFile = loadFile;
}
export { loadString, loadFile };
