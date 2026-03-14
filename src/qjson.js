// ============================================================
// qjson.js — QJSON: JSON + comments + BigInt + BigDecimal + BigFloat
//
// Superset of JSON using QuickJS bignum syntax:
//   123N          → BigInt      (native if available, else string)
//   123.456M      → BigDecimal  (QuickJS native, else string)
//   3.14L         → BigFloat    (QuickJS native, else string)
//
// Uppercase preferred, lowercase accepted.  Consistent and visible.
//   // line       → comment
//   /* block */   → comment
//
// Valid JSON is valid QJSON.  No collisions.
//
// Portable: ES5 style (var, function, no arrows).
// BigInt/BigDecimal used only at runtime if the host supports them.
//
// Usage:
//   var q = qjson.parse('{"n": 42n, "d": 3.14m}');
//   var s = qjson.stringify(q);
// ============================================================

// ── Parser ──────────────────────────────────────────────────

function qjson_parse(text) {
  var pos = 0;
  var len = text.length;

  function ch() { return pos < len ? text[pos] : ""; }

  function ws() {
    while (pos < len) {
      var c = text[pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { pos++; continue; }
      if (c === "/" && pos + 1 < len) {
        if (text[pos + 1] === "/") {
          pos += 2;
          while (pos < len && text[pos] !== "\n") pos++;
          continue;
        }
        if (text[pos + 1] === "*") {
          pos += 2;
          var depth = 1;
          while (pos + 1 < len && depth > 0) {
            if (text[pos] === "/" && text[pos + 1] === "*") { depth++; pos += 2; }
            else if (text[pos] === "*" && text[pos + 1] === "/") { depth--; pos += 2; }
            else pos++;
          }
          continue;
        }
      }
      break;
    }
  }

  function expect(c) {
    if (pos >= len || text[pos] !== c) throw new Error("Expected '" + c + "' at " + pos);
    pos++;
  }

  function ident() {
    var start = pos;
    var c = ch();
    if (!((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$"))
      throw new Error("Expected identifier at " + pos);
    pos++;
    while (pos < len) {
      c = text[pos];
      if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
          (c >= "0" && c <= "9") || c === "_" || c === "$") pos++;
      else break;
    }
    return text.substring(start, pos);
  }

  function key() {
    if (ch() === '"') return string();
    return ident();
  }

  function value() {
    ws();
    var c = ch();
    if (c === '"') return string();
    if (c === "{") return obj();
    if (c === "[") return arr();
    if (c === "t") return literal("true", true);
    if (c === "f") return literal("false", false);
    if (c === "n" && text.substr(pos, 4) === "null") return literal("null", null);
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    throw new Error("Unexpected '" + c + "' at " + pos);
  }

  function literal(word, val) {
    if (text.substr(pos, word.length) !== word) throw new Error("Expected '" + word + "' at " + pos);
    pos += word.length;
    return val;
  }

  function string() {
    expect('"');
    var parts = [];
    while (pos < len) {
      var c = text[pos];
      if (c === '"') { pos++; return parts.join(""); }
      if (c === "\\") {
        pos++;
        var e = text[pos];
        if      (e === '"')  parts.push('"');
        else if (e === "\\") parts.push("\\");
        else if (e === "/")  parts.push("/");
        else if (e === "b")  parts.push("\b");
        else if (e === "f")  parts.push("\f");
        else if (e === "n")  parts.push("\n");
        else if (e === "r")  parts.push("\r");
        else if (e === "t")  parts.push("\t");
        else if (e === "u") {
          parts.push(String.fromCharCode(parseInt(text.substr(pos + 1, 4), 16)));
          pos += 4;
        }
        pos++;
      } else {
        parts.push(c);
        pos++;
      }
    }
    throw new Error("Unterminated string");
  }

  function number() {
    var start = pos;
    if (ch() === "-") pos++;
    while (pos < len && text[pos] >= "0" && text[pos] <= "9") pos++;
    var isFloat = false;
    if (pos < len && text[pos] === ".") {
      isFloat = true;
      pos++;
      while (pos < len && text[pos] >= "0" && text[pos] <= "9") pos++;
    }
    if (pos < len && (text[pos] === "e" || text[pos] === "E")) {
      isFloat = true;
      pos++;
      if (pos < len && (text[pos] === "+" || text[pos] === "-")) pos++;
      while (pos < len && text[pos] >= "0" && text[pos] <= "9") pos++;
    }
    var raw = text.substring(start, pos);
    // BigInt suffix (N preferred, n accepted)
    if (pos < len && (text[pos] === "N" || text[pos] === "n")) {
      pos++;
      if (typeof BigInt !== "undefined") return BigInt(raw);
      return raw + "N";
    }
    // BigDecimal suffix (M preferred, m accepted)
    if (pos < len && (text[pos] === "M" || text[pos] === "m")) {
      pos++;
      if (typeof BigDecimal !== "undefined") return BigDecimal(raw);
      return raw + "M";
    }
    // BigFloat suffix (L preferred, l accepted)
    if (pos < len && (text[pos] === "L" || text[pos] === "l")) {
      pos++;
      if (typeof BigFloat !== "undefined") return BigFloat(raw);
      return raw + "L";
    }
    // Regular number
    if (isFloat) return parseFloat(raw);
    var n = parseInt(raw, 10);
    return n;
  }

  function obj() {
    expect("{");
    var d = {};
    ws();
    if (ch() === "}") { pos++; return d; }
    while (true) {
      ws();
      var k = key();
      ws(); expect(":");
      d[k] = value();
      ws();
      if (ch() === "}") { pos++; return d; }
      expect(",");
      ws();
      if (ch() === "}") { pos++; return d; }  // trailing comma
    }
  }

  function arr() {
    expect("[");
    var a = [];
    ws();
    if (ch() === "]") { pos++; return a; }
    while (true) {
      a.push(value());
      ws();
      if (ch() === "]") { pos++; return a; }
      expect(",");
      ws();
      if (ch() === "]") { pos++; return a; }  // trailing comma
    }
  }

  var result = value();
  ws();
  if (pos < len) throw new Error("Trailing content at " + pos);
  return result;
}

// ── Serializer ──────────────────────────────────────────────

function qjson_stringify(obj) {
  return _fmt(obj);
}

function _fmt(obj) {
  if (obj === null || obj === undefined) return "null";
  if (obj === true)  return "true";
  if (obj === false) return "false";
  // BigInt
  if (typeof obj === "bigint") return String(obj) + "N";
  // BigDecimal (QuickJS)
  if (typeof obj === "bigdecimal") return obj.toString() + "M";
  // BigFloat (QuickJS)
  if (typeof obj === "bigfloat") return obj.toString() + "L";
  // Number
  if (typeof obj === "number") {
    if (obj !== obj || obj === Infinity || obj === -Infinity) return "null";
    return String(obj);
  }
  // String
  if (typeof obj === "string") return _esc(obj);
  // Array
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    var items = [];
    for (var i = 0; i < obj.length; i++) items.push(_fmt(obj[i]));
    return "[" + items.join(",") + "]";
  }
  // Object
  if (typeof obj === "object") {
    var keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    var pairs = [];
    for (var i = 0; i < keys.length; i++) {
      pairs.push(_esc(keys[i]) + ":" + _fmt(obj[keys[i]]));
    }
    return "{" + pairs.join(",") + "}";
  }
  return String(obj);
}

function _esc(s) {
  var r = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if      (c === '"')  r += '\\"';
    else if (c === "\\") r += "\\\\";
    else if (c === "\n") r += "\\n";
    else if (c === "\r") r += "\\r";
    else if (c === "\t") r += "\\t";
    else if (c === "\b") r += "\\b";
    else if (c === "\f") r += "\\f";
    else if (c.charCodeAt(0) < 0x20) {
      var h = c.charCodeAt(0).toString(16);
      r += "\\u" + ("0000" + h).slice(-4);
    }
    else r += c;
  }
  return r + '"';
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.qjson_parse = qjson_parse;
  exports.qjson_stringify = qjson_stringify;
}
export { qjson_parse, qjson_stringify };
