# Prolog Form Validator

Real-time form validation powered by Prolog rules, rendered with SolidJS.
Every keystroke updates Prolog facts; validation, hints, and password strength
recompute reactively.

## What it demonstrates

- **Declarative validation**: each field's validity is a Prolog rule
  (`valid(email) :- field(email, V), str_contains(V, "@"), ...`)
- **Context-sensitive hints**: hint clauses fire based on current field state,
  giving progressive guidance as the user types
- **Cross-field dependencies**: confirm-password checks against password;
  zip format depends on selected country
- **Password strength**: `findall` counts features (upper, lower, digit,
  special, length) to derive a strength score
- **SolidJS integration**: SolidJS signals drive the UI; a generation counter
  bumps on every fact change, and memos re-query the engine

## Files

| File | Description |
|------|-------------|
| `index.html` | Complete self-contained app (HTML + CSS + JS) |

Everything is inlined — the Prolog engine, validation rules, SolidJS app,
and styling. No build tools, no npm, no bundler.

## Run

Open directly in a browser:

```bash
open examples/form/index.html
```

Or serve it:

```bash
python3 -m http.server 8000 -d examples/form
# then open http://localhost:8000
```
