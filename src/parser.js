// ============================================================
// parser.js — Prolog text parser
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
//
// Parses Prolog source text into the same term structures
// used by PrologEngine (atom, num, var, compound).
//
// Exports: parseTerm, parseClause, parseProgram
// ============================================================

// ── Token types ─────────────────────────────────────────────

var TOK_ATOM   = "ATOM";
var TOK_NUM    = "NUM";
var TOK_VAR    = "VAR";
var TOK_LPAREN = "LPAREN";
var TOK_RPAREN = "RPAREN";
var TOK_LBRACK = "LBRACK";
var TOK_RBRACK = "RBRACK";
var TOK_BAR    = "BAR";
var TOK_COMMA  = "COMMA";
var TOK_DOT    = "DOT";
var TOK_OP     = "OP";
var TOK_LBRACE = "LBRACE";
var TOK_RBRACE = "RBRACE";
var TOK_COLON  = "COLON";
var TOK_EOF    = "EOF";

// ── Operator table ──────────────────────────────────────────
// Each entry: [precedence, type, name]
// type is one of: xfx, xfy, yfx, fy, fx

var _opTable = [
  [1200, "xfx", ":-"],
  [1100, "xfy", ";"],
  [1050, "xfy", "->"],
  [1000, "xfy", ","],
  [700,  "xfx", "="],
  [700,  "xfx", "\\="],
  [700,  "xfx", "=="],
  [700,  "xfx", "\\=="],
  [700,  "xfx", "is"],
  [700,  "xfx", "=:="],
  [700,  "xfx", "=\\="],
  [700,  "xfx", "<"],
  [700,  "xfx", ">"],
  [700,  "xfx", ">="],
  [700,  "xfx", "=<"],
  [500,  "yfx", "+"],
  [500,  "yfx", "-"],
  [400,  "yfx", "*"],
  [400,  "yfx", "/"],
  [400,  "yfx", "//"],
  [400,  "yfx", "mod"]
];

var _prefixOps = [
  [900, "fy", "\\+"],
  [900, "fy", "not"],
  [200, "fy", "-"],
  [200, "fy", "abs"]
];

// Build lookup maps for fast access
var _infixByName = {};
var _prefixByName = {};

(function() {
  for (var i = 0; i < _opTable.length; i++) {
    var entry = _opTable[i];
    _infixByName[entry[2]] = { prec: entry[0], type: entry[1] };
  }
  for (var i = 0; i < _prefixOps.length; i++) {
    var entry = _prefixOps[i];
    _prefixByName[entry[2]] = { prec: entry[0], type: entry[1] };
  }
})();

// Symbolic operator characters
var _symChars = "+-*/<>=\\:";

function _isSymChar(ch) {
  return _symChars.indexOf(ch) >= 0;
}

function _isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function _isAlpha(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function _isAlnum(ch) {
  return _isAlpha(ch) || _isDigit(ch);
}

function _isLower(ch) {
  return ch >= "a" && ch <= "z";
}

function _isUpper(ch) {
  return (ch >= "A" && ch <= "Z") || ch === "_";
}

function _isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

// ── Tokenizer ───────────────────────────────────────────────

function Tokenizer(text) {
  this.text = text;
  this.pos = 0;
  this.tokens = [];
  this.idx = 0;
  this._tokenize();
}

Tokenizer.prototype._peek = function() {
  if (this.pos >= this.text.length) return "";
  return this.text.charAt(this.pos);
};

Tokenizer.prototype._advance = function() {
  var ch = this.text.charAt(this.pos);
  this.pos++;
  return ch;
};

Tokenizer.prototype._skipWhitespaceAndComments = function() {
  while (this.pos < this.text.length) {
    var ch = this._peek();
    if (_isWhitespace(ch)) {
      this._advance();
      continue;
    }
    // Line comment
    if (ch === "%" ) {
      while (this.pos < this.text.length && this.text.charAt(this.pos) !== "\n") {
        this.pos++;
      }
      continue;
    }
    // Block comment
    if (ch === "/" && this.pos + 1 < this.text.length && this.text.charAt(this.pos + 1) === "*") {
      this.pos += 2;
      while (this.pos + 1 < this.text.length) {
        if (this.text.charAt(this.pos) === "*" && this.text.charAt(this.pos + 1) === "/") {
          this.pos += 2;
          break;
        }
        this.pos++;
      }
      continue;
    }
    break;
  }
};

Tokenizer.prototype._tokenize = function() {
  while (true) {
    this._skipWhitespaceAndComments();
    if (this.pos >= this.text.length) {
      this.tokens.push({ type: TOK_EOF, value: null });
      break;
    }

    var ch = this._peek();

    // Quoted atom
    if (ch === "'") {
      this._advance();
      var buf = "";
      while (this.pos < this.text.length) {
        var c = this._advance();
        if (c === "'") {
          // Check for escaped quote ''
          if (this.pos < this.text.length && this.text.charAt(this.pos) === "'") {
            buf += "'";
            this._advance();
          } else {
            break;
          }
        } else {
          buf += c;
        }
      }
      this.tokens.push({ type: TOK_ATOM, value: buf });
      continue;
    }

    // Numbers (with optional QJSON suffix: N=BigInt, M=BigDecimal, L=BigFloat)
    if (_isDigit(ch)) {
      var numStr = "";
      while (this.pos < this.text.length && _isDigit(this._peek())) {
        numStr += this._advance();
      }
      // Check for float
      var isFloat = false;
      if (this.pos < this.text.length && this._peek() === "." &&
          this.pos + 1 < this.text.length && _isDigit(this.text.charAt(this.pos + 1))) {
        isFloat = true;
        numStr += this._advance(); // the dot
        while (this.pos < this.text.length && _isDigit(this._peek())) {
          numStr += this._advance();
        }
      }
      // Check for exponent
      if (this.pos < this.text.length && (this._peek() === "e" || this._peek() === "E")) {
        isFloat = true;
        numStr += this._advance();
        if (this.pos < this.text.length && (this._peek() === "+" || this._peek() === "-")) {
          numStr += this._advance();
        }
        while (this.pos < this.text.length && _isDigit(this._peek())) {
          numStr += this._advance();
        }
      }
      // Check for QJSON suffix (only if next char is N/n/M/m/L/l and not followed by alnum)
      var suffix = this.pos < this.text.length ? this._peek() : "";
      var afterSuffix = this.pos + 1 < this.text.length ? this.text.charAt(this.pos + 1) : "";
      if ((suffix === "N" || suffix === "n" || suffix === "M" || suffix === "m" ||
           suffix === "L" || suffix === "l") && !_isAlnum(afterSuffix)) {
        this._advance();
        var canon = suffix.toUpperCase();
        var val = isFloat ? parseFloat(numStr) : parseInt(numStr, 10);
        this.tokens.push({ type: TOK_NUM, value: val, repr: numStr + canon });
        continue;
      }
      if (isFloat) {
        this.tokens.push({ type: TOK_NUM, value: parseFloat(numStr) });
      } else {
        this.tokens.push({ type: TOK_NUM, value: parseInt(numStr, 10) });
      }
      continue;
    }

    // Variables and atoms (identifiers)
    if (_isAlpha(ch)) {
      var ident = "";
      while (this.pos < this.text.length && _isAlnum(this._peek())) {
        ident += this._advance();
      }

      // Check if it's a word-based operator
      if (ident === "is" || ident === "mod" || ident === "not" || ident === "abs") {
        this.tokens.push({ type: TOK_OP, value: ident });
        continue;
      }

      // Variable: starts with uppercase or underscore
      if (_isUpper(ident.charAt(0))) {
        this.tokens.push({ type: TOK_VAR, value: ident });
      } else {
        this.tokens.push({ type: TOK_ATOM, value: ident });
      }
      continue;
    }

    // Parentheses, brackets, comma, bar
    if (ch === "(") { this._advance(); this.tokens.push({ type: TOK_LPAREN, value: "(" }); continue; }
    if (ch === ")") { this._advance(); this.tokens.push({ type: TOK_RPAREN, value: ")" }); continue; }
    if (ch === "[") { this._advance(); this.tokens.push({ type: TOK_LBRACK, value: "[" }); continue; }
    if (ch === "]") { this._advance(); this.tokens.push({ type: TOK_RBRACK, value: "]" }); continue; }
    if (ch === "|") { this._advance(); this.tokens.push({ type: TOK_BAR, value: "|" }); continue; }
    if (ch === "{") { this._advance(); this.tokens.push({ type: TOK_LBRACE, value: "{" }); continue; }
    if (ch === "}") { this._advance(); this.tokens.push({ type: TOK_RBRACE, value: "}" }); continue; }

    // Dot: end of clause if followed by whitespace/EOF/comment
    if (ch === ".") {
      var nextPos = this.pos + 1;
      if (nextPos >= this.text.length ||
          _isWhitespace(this.text.charAt(nextPos)) ||
          this.text.charAt(nextPos) === "%" ||
          (this.text.charAt(nextPos) === "/" && nextPos + 1 < this.text.length && this.text.charAt(nextPos + 1) === "*")) {
        this._advance();
        this.tokens.push({ type: TOK_DOT, value: "." });
        continue;
      }
      // Otherwise it could be part of a list cons or a float after digit
      // (float handled above in number parsing)
      // As a standalone dot operator, treat it as a DOT token
      this._advance();
      this.tokens.push({ type: TOK_DOT, value: "." });
      continue;
    }

    // Comma
    if (ch === ",") { this._advance(); this.tokens.push({ type: TOK_COMMA, value: "," }); continue; }

    // Semicolon (disjunction operator)
    if (ch === ";") { this._advance(); this.tokens.push({ type: TOK_OP, value: ";" }); continue; }

    // Exclamation mark (cut) - treat as atom
    if (ch === "!") { this._advance(); this.tokens.push({ type: TOK_ATOM, value: "!" }); continue; }

    // Standalone colon (not :- which is a symbolic operator)
    if (ch === ":" && !(this.pos + 1 < this.text.length && this.text.charAt(this.pos + 1) === "-")) {
      this._advance();
      this.tokens.push({ type: TOK_COLON, value: ":" });
      continue;
    }

    // Symbolic operators
    if (_isSymChar(ch)) {
      var sym = "";
      while (this.pos < this.text.length && _isSymChar(this._peek())) {
        sym += this._advance();
      }
      this.tokens.push({ type: TOK_OP, value: sym });
      continue;
    }

    // Unknown character - skip
    this._advance();
  }
};

Tokenizer.prototype.peek = function() {
  return this.tokens[this.idx];
};

Tokenizer.prototype.next = function() {
  var tok = this.tokens[this.idx];
  if (this.idx < this.tokens.length - 1) this.idx++;
  return tok;
};

Tokenizer.prototype.expect = function(type, valueOpt) {
  var tok = this.next();
  if (tok.type !== type) {
    throw new Error("Expected " + type + " but got " + tok.type + " (" + JSON.stringify(tok.value) + ")");
  }
  if (valueOpt !== undefined && tok.value !== valueOpt) {
    throw new Error("Expected " + JSON.stringify(valueOpt) + " but got " + JSON.stringify(tok.value));
  }
  return tok;
};

// ── Parser ──────────────────────────────────────────────────
// Pratt parser (operator-precedence) for Prolog terms.

function Parser(text) {
  this.tokenizer = new Tokenizer(text);
}

// Parse a term up to a given max precedence
Parser.prototype.parseExpr = function(maxPrec) {
  var left = this._parsePrimary();

  while (true) {
    var tok = this.tokenizer.peek();
    var opInfo = null;
    var opName = null;

    if (tok.type === TOK_OP || tok.type === TOK_ATOM) {
      opName = tok.value;
      opInfo = _infixByName[opName];
    } else if (tok.type === TOK_COMMA) {
      opName = ",";
      opInfo = _infixByName[","];
    }

    if (!opInfo) break;

    // Check precedence: for xfx and xfy, left prec must be < op prec
    // for yfx, left prec must be <= op prec
    if (opInfo.prec > maxPrec) break;

    this.tokenizer.next(); // consume operator

    // Determine right-side max precedence
    var rightPrec;
    if (opInfo.type === "yfx") {
      rightPrec = opInfo.prec - 1;
    } else if (opInfo.type === "xfy") {
      rightPrec = opInfo.prec;
    } else {
      // xfx
      rightPrec = opInfo.prec - 1;
    }

    var right = this.parseExpr(rightPrec);
    left = { type: "compound", functor: opName, args: [left, right] };
  }

  return left;
};

Parser.prototype._parsePrimary = function() {
  var tok = this.tokenizer.peek();

  // Prefix operators
  if (tok.type === TOK_OP || tok.type === TOK_ATOM) {
    var prefixInfo = _prefixByName[tok.value];
    if (prefixInfo) {
      var opName = tok.value;

      // For unary minus: only treat as prefix if next token is not something
      // that would make this an infix minus. Check if we're at the start or
      // after an operator/open bracket.
      if (opName === "-") {
        // Unary minus: parse the operand
        this.tokenizer.next();

        // Check for immediate number (negative literal)
        var nextTok = this.tokenizer.peek();
        if (nextTok.type === TOK_NUM) {
          this.tokenizer.next();
          var nterm = { type: "num", value: -nextTok.value };
          if (nextTok.repr) nterm.repr = "-" + nextTok.repr;
          return nterm;
        }

        var rightPrec;
        if (prefixInfo.type === "fy") {
          rightPrec = prefixInfo.prec;
        } else {
          rightPrec = prefixInfo.prec - 1;
        }
        var operand = this.parseExpr(rightPrec);
        return { type: "compound", functor: "-", args: [operand] };
      }

      // For not, \+, abs: check if followed by ( for compound syntax
      // e.g., not(X) should be compound("not", [X])
      if ((opName === "not" || opName === "\\+" || opName === "abs") &&
          this.tokenizer.tokens[this.tokenizer.idx + 1] &&
          this.tokenizer.tokens[this.tokenizer.idx + 1].type === TOK_LPAREN) {
        // Check if next token is LPAREN (i.e., functor syntax like not(...))
        var nextTok = this.tokenizer.tokens[this.tokenizer.idx + 1];
        if (nextTok && nextTok.type === TOK_LPAREN) {
          // Parse as compound term: not(X) or abs(X)
          this.tokenizer.next(); // consume the operator-as-atom
          return this._parseCompound(opName);
        }
      }

      this.tokenizer.next(); // consume prefix op
      var rightPrec;
      if (prefixInfo.type === "fy") {
        rightPrec = prefixInfo.prec;
      } else {
        rightPrec = prefixInfo.prec - 1;
      }
      var operand = this.parseExpr(rightPrec);
      return { type: "compound", functor: opName, args: [operand] };
    }
  }

  // Parenthesized expression
  if (tok.type === TOK_LPAREN) {
    this.tokenizer.next();
    var expr = this.parseExpr(1200);
    this.tokenizer.expect(TOK_RPAREN);
    return expr;
  }

  // QJSON object literal
  if (tok.type === TOK_LBRACE) {
    return this._parseObject();
  }

  // List
  if (tok.type === TOK_LBRACK) {
    return this._parseList();
  }

  // Number (with optional QJSON repr)
  if (tok.type === TOK_NUM) {
    this.tokenizer.next();
    var nterm = { type: "num", value: tok.value };
    if (tok.repr) nterm.repr = tok.repr;
    return nterm;
  }

  // Variable
  if (tok.type === TOK_VAR) {
    this.tokenizer.next();
    return { type: "var", name: tok.value };
  }

  // Atom (may be followed by '(' for compound term)
  if (tok.type === TOK_ATOM) {
    this.tokenizer.next();
    var name = tok.value;

    // Check for compound term: atom followed by '('
    if (this.tokenizer.peek().type === TOK_LPAREN) {
      return this._parseCompound(name);
    }

    return { type: "atom", name: name };
  }

  // Operator used as atom (e.g., `=` in a compound context)
  if (tok.type === TOK_OP) {
    this.tokenizer.next();
    return { type: "atom", name: tok.value };
  }

  throw new Error("Unexpected token: " + tok.type + " (" + JSON.stringify(tok.value) + ")");
};

Parser.prototype._parseCompound = function(functor) {
  this.tokenizer.expect(TOK_LPAREN);
  var args = [];
  if (this.tokenizer.peek().type !== TOK_RPAREN) {
    args.push(this.parseExpr(999)); // args are parsed at prec < comma
    while (this.tokenizer.peek().type === TOK_COMMA) {
      this.tokenizer.next();
      args.push(this.parseExpr(999));
    }
  }
  this.tokenizer.expect(TOK_RPAREN);
  return { type: "compound", functor: functor, args: args };
};

Parser.prototype._parseList = function() {
  this.tokenizer.expect(TOK_LBRACK);

  // Empty list
  if (this.tokenizer.peek().type === TOK_RBRACK) {
    this.tokenizer.next();
    return { type: "atom", name: "[]" };
  }

  var items = [];
  items.push(this.parseExpr(999));
  while (this.tokenizer.peek().type === TOK_COMMA) {
    this.tokenizer.next();
    items.push(this.parseExpr(999));
  }

  var tail = { type: "atom", name: "[]" };
  if (this.tokenizer.peek().type === TOK_BAR) {
    this.tokenizer.next();
    tail = this.parseExpr(999);
  }

  this.tokenizer.expect(TOK_RBRACK);

  // Build list from right: .(item, .(item, ... tail))
  var result = tail;
  for (var i = items.length - 1; i >= 0; i--) {
    result = { type: "compound", functor: ".", args: [items[i], result] };
  }
  return result;
};

Parser.prototype._parseObject = function() {
  this.tokenizer.expect(TOK_LBRACE);
  var pairs = [];
  if (this.tokenizer.peek().type !== TOK_RBRACE) {
    while (true) {
      // Key: atom or quoted atom (string key)
      var keyTok = this.tokenizer.next();
      var key;
      if (keyTok.type === TOK_ATOM) {
        key = keyTok.value;
      } else if (keyTok.type === TOK_VAR) {
        throw new Error("Object keys must be atoms, got variable: " + keyTok.value);
      } else {
        throw new Error("Expected object key (atom), got: " + keyTok.type);
      }
      this.tokenizer.expect(TOK_COLON);
      var value = this.parseExpr(999);
      pairs.push({ key: key, value: value });
      if (this.tokenizer.peek().type === TOK_COMMA) {
        this.tokenizer.next();
        // Allow trailing comma
        if (this.tokenizer.peek().type === TOK_RBRACE) break;
      } else {
        break;
      }
    }
  }
  this.tokenizer.expect(TOK_RBRACE);
  return { type: "object", pairs: pairs };
};

// ── Clause body flattening ──────────────────────────────────
// Flatten top-level commas in a body term into an array.
// Only top-level commas are flattened; commas inside ;, ->, not etc
// remain as compound terms.

function _flattenComma(term) {
  if (term.type === "compound" && term.functor === "," && term.args.length === 2) {
    var left = _flattenComma(term.args[0]);
    var right = _flattenComma(term.args[1]);
    return left.concat(right);
  }
  return [term];
}

// ── Public API ──────────────────────────────────────────────

function parseTerm(text) {
  var parser = new Parser(text);
  var term = parser.parseExpr(1200);
  return term;
}

function parseClause(text) {
  // Strip trailing dot if present
  var trimmed = text.replace(/^\s+/, "").replace(/\s+$/, "");
  if (trimmed.charAt(trimmed.length - 1) === ".") {
    // Check if the dot is a clause terminator (not part of a number like 3.14)
    // Simple heuristic: if last char is '.', check preceding char
    var preDot = trimmed.charAt(trimmed.length - 2);
    if (!_isDigit(preDot)) {
      trimmed = trimmed.substring(0, trimmed.length - 1);
    }
  }

  var parser = new Parser(trimmed);
  var term = parser.parseExpr(1200);

  if (term.type === "compound" && term.functor === ":-" && term.args.length === 2) {
    return {
      head: term.args[0],
      body: _flattenComma(term.args[1])
    };
  }

  return { head: term, body: [] };
}

function parseProgram(text) {
  var tokenizer = new Tokenizer(text);
  var clauses = [];
  var start = 0;

  // Collect positions of DOT tokens to split the text
  var dotPositions = [];
  for (var i = 0; i < tokenizer.tokens.length; i++) {
    if (tokenizer.tokens[i].type === TOK_DOT) {
      dotPositions.push(i);
    }
  }

  // For each dot, parse the tokens before it as a clause
  var tokenStart = 0;
  for (var d = 0; d < dotPositions.length; d++) {
    var dotIdx = dotPositions[d];

    // Extract the sub-token sequence
    var subTokens = [];
    for (var t = tokenStart; t < dotIdx; t++) {
      subTokens.push(tokenizer.tokens[t]);
    }

    if (subTokens.length === 0) {
      tokenStart = dotIdx + 1;
      continue;
    }

    // Add EOF to the end
    subTokens.push({ type: TOK_EOF, value: null });

    // Create a parser-like object that uses these tokens
    var subParser = {};
    subParser.tokenizer = {
      tokens: subTokens,
      idx: 0,
      peek: function() { return this.tokens[this.idx]; },
      next: function() {
        var tok = this.tokens[this.idx];
        if (this.idx < this.tokens.length - 1) this.idx++;
        return tok;
      },
      expect: function(type, valueOpt) {
        var tok = this.next();
        if (tok.type !== type) {
          throw new Error("Expected " + type + " but got " + tok.type + " (" + JSON.stringify(tok.value) + ")");
        }
        if (valueOpt !== undefined && tok.value !== valueOpt) {
          throw new Error("Expected " + JSON.stringify(valueOpt) + " but got " + JSON.stringify(tok.value));
        }
        return tok;
      }
    };

    // Borrow the parser methods
    subParser.parseExpr = Parser.prototype.parseExpr;
    subParser._parsePrimary = Parser.prototype._parsePrimary;
    subParser._parseCompound = Parser.prototype._parseCompound;
    subParser._parseList = Parser.prototype._parseList;
    subParser._parseObject = Parser.prototype._parseObject;

    var term = subParser.parseExpr(1200);

    if (term.type === "compound" && term.functor === ":-" && term.args.length === 2) {
      clauses.push({
        head: term.args[0],
        body: _flattenComma(term.args[1])
      });
    } else {
      clauses.push({ head: term, body: [] });
    }

    tokenStart = dotIdx + 1;
  }

  return clauses;
}

// ── Export (dual ESM/CJS) ─────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.parseTerm = parseTerm;
  exports.parseClause = parseClause;
  exports.parseProgram = parseProgram;
}
export { parseTerm, parseClause, parseProgram };
