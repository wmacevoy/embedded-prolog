# Margin Trading Engine

A real-time margin trading monitor with position tracking, P&L calculations,
trigger conditions (take-profit, stop-loss, liquidation), and margin status
transitions.

## What it demonstrates

- **Financial decision rules**: margin ratio thresholds drive status transitions
  (healthy → warning → margin_call → liquidation)
- **Precise arithmetic**: uses QuickJS BigDecimal when available, falls back to
  standard Number on other runtimes
- **Dynamic triggers**: add/remove trigger configurations at runtime; the engine
  derives which triggers are active from current prices
- **Reactive layer**: status, triggers, and equity recompute automatically when
  prices or balances change

## Files

| File | Language | Description |
|------|----------|-------------|
| `margin-kb.js` | JavaScript | Knowledge base with BigDecimal support |
| `test.js` | JavaScript | 28 tests |

## Run

```bash
# Node.js
node examples/margin/test.js

# QuickJS with BigDecimal precision
qjs --bignum --module examples/margin/test.js

# Other runtimes
bun run examples/margin/test.js
deno run examples/margin/test.js
```
