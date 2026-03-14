# ============================================================
# qjson.py — QJSON: JSON + comments + BigInt + BigDecimal + BigFloat
#
# Superset of JSON using QuickJS bignum syntax:
#   123N          → BigInt      (Python: BigInt subclass of int)
#   123.456M      → BigDecimal  (Python: decimal.Decimal)
#   3.14L         → BigFloat    (Python: BigFloat — preserves full precision)
#
# Uppercase preferred, lowercase accepted.  Consistent and visible.
#   // line       → comment
#   /* block */   → comment
#
# Valid JSON is valid QJSON.  No collisions.
#
# Usage:
#   from qjson import parse, stringify, BigInt, BigFloat
#   obj = parse('{"n": 42n, "d": 3.14m, "f": 3.14l}')
#   text = stringify(obj)
# ============================================================

from decimal import Decimal


class BigInt(int):
    """Integer that round-trips through QJSON with 'n' suffix."""
    pass


class BigFloat:
    """High-precision base-2 float.  Round-trips with 'l' suffix.

    Stores the full-precision string so no bits are lost.
    float(bf) gives the nearest 64-bit IEEE value.
    """
    __slots__ = ("_raw",)

    def __init__(self, value):
        self._raw = str(value)

    def __float__(self):
        return float(self._raw)

    def __repr__(self):
        return "BigFloat('%s')" % self._raw

    def __str__(self):
        return self._raw

    def __eq__(self, other):
        if isinstance(other, BigFloat):
            return self._raw == other._raw
        return NotImplemented

    def __hash__(self):
        return hash(("BigFloat", self._raw))


# ── Parser ───────────────────────────────────────────────────

def parse(text):
    """Parse QJSON text to Python objects."""
    p = _Parser(text)
    val = p.value()
    p.ws()
    if p.pos < p.end:
        raise ValueError("Trailing content at %d" % p.pos)
    return val


class _Parser:
    __slots__ = ("text", "pos", "end")

    def __init__(self, text):
        self.text = text
        self.pos = 0
        self.end = len(text)

    def ch(self):
        return self.text[self.pos] if self.pos < self.end else ""

    def ws(self):
        while self.pos < self.end:
            c = self.text[self.pos]
            if c in " \t\n\r":
                self.pos += 1
            elif c == "/" and self.pos + 1 < self.end:
                c2 = self.text[self.pos + 1]
                if c2 == "/":
                    self.pos += 2
                    while self.pos < self.end and self.text[self.pos] != "\n":
                        self.pos += 1
                elif c2 == "*":
                    self.pos += 2
                    depth = 1
                    while self.pos + 1 < self.end and depth > 0:
                        if self.text[self.pos] == "/" and self.text[self.pos + 1] == "*":
                            depth += 1
                            self.pos += 2
                        elif self.text[self.pos] == "*" and self.text[self.pos + 1] == "/":
                            depth -= 1
                            self.pos += 2
                        else:
                            self.pos += 1
                    if depth > 0:
                        raise ValueError("Unterminated block comment")
                else:
                    break
            else:
                break

    def expect(self, c):
        if self.pos >= self.end or self.text[self.pos] != c:
            raise ValueError("Expected '%s' at %d" % (c, self.pos))
        self.pos += 1

    def ident(self):
        """Parse an unquoted key (JS identifier)."""
        start = self.pos
        c = self.ch()
        if not (c.isalpha() or c == "_" or c == "$"):
            raise ValueError("Expected identifier at %d" % self.pos)
        self.pos += 1
        while self.pos < self.end:
            c = self.text[self.pos]
            if c.isalnum() or c == "_" or c == "$":
                self.pos += 1
            else:
                break
        return self.text[start:self.pos]

    def key(self):
        """Parse a key: quoted string or bare identifier."""
        if self.ch() == '"':
            return self.string()
        return self.ident()

    def value(self):
        self.ws()
        c = self.ch()
        if c == '"':  return self.string()
        if c == "{":  return self.obj()
        if c == "[":  return self.arr()
        if c == "t":  return self.literal("true", True)
        if c == "f":  return self.literal("false", False)
        if c == "n" and self.text[self.pos:self.pos + 4] == "null":
            return self.literal("null", None)
        if c == "-" or c.isdigit():
            return self.number()
        raise ValueError("Unexpected '%s' at %d" % (c, self.pos))

    def literal(self, word, val):
        if self.text[self.pos:self.pos + len(word)] != word:
            raise ValueError("Expected '%s' at %d" % (word, self.pos))
        self.pos += len(word)
        return val

    def string(self):
        self.expect('"')
        parts = []
        while self.pos < self.end:
            c = self.text[self.pos]
            if c == '"':
                self.pos += 1
                return "".join(parts)
            if c == "\\":
                self.pos += 1
                e = self.text[self.pos]
                if   e == '"':  parts.append('"')
                elif e == "\\": parts.append("\\")
                elif e == "/":  parts.append("/")
                elif e == "b":  parts.append("\b")
                elif e == "f":  parts.append("\f")
                elif e == "n":  parts.append("\n")
                elif e == "r":  parts.append("\r")
                elif e == "t":  parts.append("\t")
                elif e == "u":
                    h = self.text[self.pos + 1:self.pos + 5]
                    parts.append(chr(int(h, 16)))
                    self.pos += 4
                self.pos += 1
            else:
                parts.append(c)
                self.pos += 1
        raise ValueError("Unterminated string")

    def number(self):
        start = self.pos
        if self.ch() == "-":
            self.pos += 1
        while self.pos < self.end and self.text[self.pos].isdigit():
            self.pos += 1
        is_float = False
        if self.pos < self.end and self.text[self.pos] == ".":
            is_float = True
            self.pos += 1
            while self.pos < self.end and self.text[self.pos].isdigit():
                self.pos += 1
        if self.pos < self.end and self.text[self.pos] in "eE":
            is_float = True
            self.pos += 1
            if self.pos < self.end and self.text[self.pos] in "+-":
                self.pos += 1
            while self.pos < self.end and self.text[self.pos].isdigit():
                self.pos += 1
        raw = self.text[start:self.pos]
        # BigInt suffix (N preferred, n accepted)
        if self.pos < self.end and self.text[self.pos] in "nN":
            self.pos += 1
            return BigInt(raw)
        # BigDecimal suffix (M preferred, m accepted)
        if self.pos < self.end and self.text[self.pos] in "mM":
            self.pos += 1
            return Decimal(raw)
        # BigFloat suffix (L preferred, l accepted)
        if self.pos < self.end and self.text[self.pos] in "lL":
            self.pos += 1
            return BigFloat(raw)
        # Regular number
        if is_float:
            return float(raw)
        return int(raw)

    def obj(self):
        self.expect("{")
        d = {}
        self.ws()
        if self.ch() == "}":
            self.pos += 1
            return d
        while True:
            self.ws()
            k = self.key()
            self.ws()
            self.expect(":")
            d[k] = self.value()
            self.ws()
            if self.ch() == "}":
                self.pos += 1
                return d
            self.expect(",")
            self.ws()
            if self.ch() == "}":  # trailing comma
                self.pos += 1
                return d

    def arr(self):
        self.expect("[")
        a = []
        self.ws()
        if self.ch() == "]":
            self.pos += 1
            return a
        while True:
            a.append(self.value())
            self.ws()
            if self.ch() == "]":
                self.pos += 1
                return a
            self.expect(",")
            self.ws()
            if self.ch() == "]":  # trailing comma
                self.pos += 1
                return a


# ── Serializer ───────────────────────────────────────────────

def stringify(obj, indent=None):
    """Serialize to QJSON.  BigInt → 'n', Decimal → 'm', BigFloat → 'l'."""
    return _fmt(obj, indent, 0)


def _fmt(obj, ind, depth):
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, BigFloat):
        return obj._raw + "L"
    if isinstance(obj, BigInt):
        return int.__repr__(obj) + "N"
    if isinstance(obj, Decimal):
        return str(obj) + "M"
    if isinstance(obj, float):
        if obj != obj or obj == float("inf") or obj == float("-inf"):
            return "null"
        return repr(obj)
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, str):
        return _esc(obj)
    if isinstance(obj, (list, tuple)):
        if not obj:
            return "[]"
        if ind is None:
            return "[" + ",".join(_fmt(v, None, 0) for v in obj) + "]"
        nl = "\n" + " " * (ind * (depth + 1))
        end = "\n" + " " * (ind * depth)
        return "[" + ",".join(nl + _fmt(v, ind, depth + 1) for v in obj) + end + "]"
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        if ind is None:
            return "{" + ",".join(
                _esc(k) + ":" + _fmt(v, None, 0) for k, v in obj.items()
            ) + "}"
        nl = "\n" + " " * (ind * (depth + 1))
        end = "\n" + " " * (ind * depth)
        return "{" + ",".join(
            nl + _esc(k) + ": " + _fmt(v, ind, depth + 1) for k, v in obj.items()
        ) + end + "}"
    return str(obj)


_ESC = {'"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r",
        "\t": "\\t", "\b": "\\b", "\f": "\\f"}

def _esc(s):
    r = ['"']
    for c in s:
        if c in _ESC:
            r.append(_ESC[c])
        elif ord(c) < 0x20:
            r.append("\\u%04x" % ord(c))
        else:
            r.append(c)
    r.append('"')
    return "".join(r)
