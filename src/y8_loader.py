# ============================================================
# y8_loader.py — Load Prolog text into Y8 Datalog
#
# Parses Prolog source text and translates to y8_datalog API:
#   fact       → db.assert_fact(functor, args)
#   rule       → db.add_rule(clause)
#   react rule → db.add_react(pattern, handler) + db.add_rule(clause)
#
# Usage:
#   from y8_loader import load_program
#   load_program(db, """
#     parent(alice, bob).
#     parent(bob, carol).
#     grandparent(GP, GC) :- parent(GP, Y), parent(Y, GC).
#   """)
# ============================================================

import re
from qjson import Unbound


def load_program(db, text):
    """Parse Prolog text and load into Y8 Datalog database.

    Returns number of clauses loaded.
    """
    clauses = _parse_program(text)
    count = 0
    for head, body in clauses:
        if not body:
            # Fact
            functor = head[0]
            args = head[1:]
            db.assert_fact(functor, args)
        else:
            # Rule
            clause = [head] + body
            db.add_rule(clause)
        count += 1
    return count


def load_string(db, text):
    """Alias for load_program."""
    return load_program(db, text)


# ── Minimal Prolog parser ────────────────────────────────────
# Parses a subset of Prolog sufficient for Datalog:
#   - facts: functor(arg1, arg2, ...).
#   - rules: head :- body1, body2, ...
#   - atoms: lowercase identifiers, quoted 'atoms'
#   - variables: Uppercase identifiers, _ (anonymous)
#   - numbers: integers and floats, QJSON suffixes (N, M, L)
#   - strings: "double quoted"
#   - QJSON objects: {key: value, ...}
#   - lists: [a, b, c] and [H|T]

def _parse_program(text):
    """Parse Prolog text into list of (head, body) tuples."""
    # Split on '.' that ends a clause
    clauses = []
    # Simple split: find '.' followed by whitespace or EOF
    i = 0
    while i < len(text):
        # Skip whitespace and comments
        i = _skip_ws(text, i)
        if i >= len(text):
            break
        # Find end of clause (period followed by whitespace/EOF)
        end = _find_clause_end(text, i)
        if end < 0:
            break
        clause_text = text[i:end].strip()
        if clause_text:
            head, body = _parse_clause(clause_text)
            if head is not None:
                clauses.append((head, body))
        i = end + 1  # skip the '.'
    return clauses


def _skip_ws(text, i):
    """Skip whitespace and comments."""
    while i < len(text):
        if text[i] in ' \t\n\r':
            i += 1
        elif text[i] == '%':
            while i < len(text) and text[i] != '\n':
                i += 1
        elif text[i:i+2] == '/*':
            i += 2
            while i + 1 < len(text):
                if text[i:i+2] == '*/':
                    i += 2
                    break
                i += 1
        else:
            break
    return i


def _find_clause_end(text, start):
    """Find the '.' that ends a clause (not inside quotes/parens)."""
    i = start
    depth = 0  # paren/bracket depth
    in_sq = False  # single quote
    in_dq = False  # double quote
    while i < len(text):
        c = text[i]
        if in_sq:
            if c == "'" and (i + 1 >= len(text) or text[i+1] != "'"):
                in_sq = False
            elif c == "'" and i + 1 < len(text) and text[i+1] == "'":
                i += 1  # escaped quote
            i += 1
            continue
        if in_dq:
            if c == '"' and (i == start or text[i-1] != '\\'):
                in_dq = False
            i += 1
            continue
        if c == "'":
            in_sq = True
            i += 1
            continue
        if c == '"':
            in_dq = True
            i += 1
            continue
        if c == '%':
            while i < len(text) and text[i] != '\n':
                i += 1
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == '.' and depth == 0:
            # Check if followed by whitespace/EOF/comment
            j = i + 1
            if j >= len(text) or text[j] in ' \t\n\r%':
                return i
            # Check if it's a decimal point (digit before and after)
            if i > start and text[i-1].isdigit() and j < len(text) and text[j].isdigit():
                i += 1
                continue
            # Otherwise treat as clause end
            return i
        i += 1
    return -1


def _parse_clause(text):
    """Parse a single clause (without trailing dot)."""
    # Check for :- (rule)
    parts = _split_rule(text)
    if parts:
        head_text, body_text = parts
        head = _parse_term(head_text.strip())
        body = _parse_body(body_text.strip())
        return head, body
    else:
        head = _parse_term(text.strip())
        return head, []


def _split_rule(text):
    """Split 'head :- body' into (head_text, body_text), or None if fact."""
    depth = 0
    in_sq = False
    in_dq = False
    i = 0
    while i < len(text):
        c = text[i]
        if in_sq:
            if c == "'" and (i + 1 >= len(text) or text[i+1] != "'"):
                in_sq = False
            elif c == "'":
                i += 1
            i += 1
            continue
        if in_dq:
            if c == '"' and (i == 0 or text[i-1] != '\\'):
                in_dq = False
            i += 1
            continue
        if c == "'":
            in_sq = True
        elif c == '"':
            in_dq = True
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ':' and i + 1 < len(text) and text[i+1] == '-' and depth == 0:
            return text[:i], text[i+2:]
        i += 1
    return None


def _parse_body(text):
    """Parse comma-separated body goals."""
    goals = []
    parts = _split_commas(text)
    for part in parts:
        term = _parse_term(part.strip())
        if term is not None:
            goals.append(term)
    return goals


def _split_commas(text):
    """Split on top-level commas."""
    parts = []
    depth = 0
    in_sq = False
    in_dq = False
    start = 0
    i = 0
    while i < len(text):
        c = text[i]
        if in_sq:
            if c == "'" and (i + 1 >= len(text) or text[i+1] != "'"):
                in_sq = False
            elif c == "'":
                i += 1
            i += 1
            continue
        if in_dq:
            if c == '"' and (i == 0 or text[i-1] != '\\'):
                in_dq = False
            i += 1
            continue
        if c == "'":
            in_sq = True
        elif c == '"':
            in_dq = True
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ',' and depth == 0:
            parts.append(text[start:i])
            start = i + 1
        i += 1
    if start < len(text):
        parts.append(text[start:])
    return parts


def _parse_term(text):
    """Parse a single Prolog term into [functor, arg1, arg2, ...] array."""
    text = text.strip()
    if not text:
        return None

    # Number (with optional QJSON suffix)
    m = re.match(r'^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([NMLnml]?)$', text)
    if m:
        raw = m.group(1)
        suffix = m.group(2).upper()
        if suffix:
            return raw + suffix
        if '.' in raw or 'e' in raw or 'E' in raw:
            return float(raw)
        return int(raw)

    # Quoted atom 'like this'
    if text.startswith("'") and text.endswith("'"):
        return text[1:-1].replace("''", "'")

    # Double-quoted string
    if text.startswith('"') and text.endswith('"'):
        return text[1:-1]

    # Variable
    if text[0].isupper() or text[0] == '_':
        if text == '_':
            return Unbound('')
        return Unbound(text)

    # List
    if text.startswith('[') and text.endswith(']'):
        inner = text[1:-1].strip()
        if not inner:
            return []
        items = _split_commas(inner)
        return [_parse_term(item.strip()) for item in items]

    # Compound: functor(arg1, arg2, ...)
    paren = text.find('(')
    if paren > 0 and text.endswith(')'):
        functor = text[:paren].strip()
        args_text = text[paren+1:-1]
        args = _split_commas(args_text)
        result = [functor]
        for arg in args:
            result.append(_parse_term(arg.strip()))
        return result

    # Bare atom
    if re.match(r'^[a-z_][a-zA-Z0-9_]*$', text):
        return text

    # Fallback
    return text
