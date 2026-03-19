// y8-core.js — Canonical interval projection via native libbf
//
// Loads the y8_core shared library (built from libbf + y8_qjson.c).
// Falls back to pure JS polyfill if native not available.
//
// Usage:
//   var y8 = require('./y8_core');
//   var iv = y8.project("0.1");  // { lo: 0.0999..., hi: 0.1 }
//   var r = y8.cmp(a_lo, a_hi, a_str, b_lo, b_hi, b_str);  // -1, 0, 1

var _native = null;
var _available = false;

// Try to load native via Node's ffi or Bun's dlopen
function _tryLoad() {
  if (_native !== null) return _available;

  try {
    // Bun has built-in dlopen
    if (typeof Bun !== "undefined" && Bun.dlopen) {
      var path = __dirname + "/y8_core" +
        (process.platform === "darwin" ? ".dylib" : ".so");
      var lib = Bun.dlopen(path, {
        y8_project: { args: ["ptr", "i32", "ptr", "ptr"], returns: "void" },
        y8_cmp: { args: ["f64","f64","ptr","i32","f64","f64","ptr","i32"], returns: "i32" },
        y8_decimal_cmp: { args: ["ptr","i32","ptr","i32"], returns: "i32" },
      });
      _native = lib.symbols;
      _available = true;
      return true;
    }
  } catch(e) {}

  _native = {};
  _available = false;
  return false;
}

// ── Public API ──────────────────────────────────────────

function project(raw) {
  _tryLoad();
  if (_available) {
    // Native path via Bun dlopen
    var lo = new Float64Array(1);
    var hi = new Float64Array(1);
    var buf = Buffer.from(raw);
    _native.y8_project(buf, buf.length, lo, hi);
    return { lo: lo[0], hi: hi[0] };
  }
  // Fallback: pure JS (toPrecision polyfill)
  return _projectFallback(raw);
}

function cmp(a_lo, a_hi, a_str, b_lo, b_hi, b_str) {
  // Fast path: intervals separated
  if (a_hi < b_lo) return -1;
  if (a_lo > b_hi) return 1;
  if (a_lo === a_hi && b_lo === b_hi) return 0;

  if (_available) {
    var a_buf = a_str ? Buffer.from(a_str) : null;
    var b_buf = b_str ? Buffer.from(b_str) : null;
    return _native.y8_decimal_cmp(
      a_buf, a_buf ? a_buf.length : 0,
      b_buf, b_buf ? b_buf.length : 0
    );
  }
  // Fallback: string comparison
  return _decCmpFallback(a_str || "", b_str || "");
}

function decimal_cmp(a, b) {
  _tryLoad();
  if (_available) {
    var a_buf = Buffer.from(a);
    var b_buf = Buffer.from(b);
    return _native.y8_decimal_cmp(a_buf, a_buf.length, b_buf, b_buf.length);
  }
  return _decCmpFallback(a, b);
}

// ── Fallback (pure JS, no native) ───────────────────────

function _decCmpFallback(a, b) {
  // Simple decimal string comparison
  var aDot = a.indexOf(".");
  var bDot = b.indexOf(".");
  var aInt = (aDot >= 0 ? a.substring(0, aDot) : a).replace(/^0+/, "") || "0";
  var bInt = (bDot >= 0 ? b.substring(0, bDot) : b).replace(/^0+/, "") || "0";
  if (aInt.length !== bInt.length) return aInt.length > bInt.length ? 1 : -1;
  if (aInt > bInt) return 1;
  if (aInt < bInt) return -1;
  var aFrac = aDot >= 0 ? a.substring(aDot + 1) : "";
  var bFrac = bDot >= 0 ? b.substring(bDot + 1) : "";
  var maxLen = Math.max(aFrac.length, bFrac.length);
  while (aFrac.length < maxLen) aFrac += "0";
  while (bFrac.length < maxLen) bFrac += "0";
  if (aFrac > bFrac) return 1;
  if (aFrac < bFrac) return -1;
  return 0;
}

function _projectFallback(raw) {
  var v = Number(raw);
  if (v === Infinity) return { lo: Number.MAX_VALUE, hi: Infinity };
  if (v === -Infinity) return { lo: -Infinity, hi: -Number.MAX_VALUE };
  // Determine rounding direction via toPrecision
  var maxPrec = 21;
  try { (1.0).toPrecision(100); maxPrec = 100; } catch(e) {}
  if (v === 0) {
    var clean = raw.replace(/^[-+]/, "").replace(/[0.]/g, "");
    if (clean === "") return { lo: 0, hi: 0 };
    return raw.charAt(0) === "-" ? { lo: -5e-324, hi: 0 } : { lo: 0, hi: 5e-324 };
  }
  var neg = v < 0;
  var absV = neg ? -v : v;
  var absRaw = raw.charAt(0) === "-" ? raw.substring(1) : raw;
  var dStr = absV.toPrecision(maxPrec);
  var dir = _decCmpFallback(dStr, absRaw);
  if (neg) dir = -dir;
  if (dir === 0) return { lo: v, hi: v };
  // nextUp/nextDown via bit manipulation
  if (dir > 0) return { lo: _nextDown(v), hi: v };
  return { lo: v, hi: _nextUp(v) };
}

function _nextUp(x) {
  if (x !== x || x === Infinity) return x;
  if (x === 0) return 5e-324;
  var buf = new ArrayBuffer(8);
  var f64 = new Float64Array(buf);
  var u32 = new Uint32Array(buf);
  f64[0] = x;
  if (x > 0) { u32[0]++; if (u32[0] === 0) u32[1]++; }
  else { if (u32[0] === 0) u32[1]--; u32[0]--; }
  return f64[0];
}

function _nextDown(x) { return -_nextUp(-x); }

// ── Export ──────────────────────────────────────────────

if (typeof module !== "undefined") {
  module.exports = { project: project, cmp: cmp, decimal_cmp: decimal_cmp };
}
if (typeof exports !== "undefined") {
  exports.project = project;
  exports.cmp = cmp;
  exports.decimal_cmp = decimal_cmp;
}
