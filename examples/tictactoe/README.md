# Tic-Tac-Toe

Human vs. AI tic-tac-toe where the AI strategy is expressed entirely as Prolog
rules.

## What it demonstrates

- **Game AI as logic**: `choose_move(Board, Player, Move)` tries win, then
  block, then center, then corners, then any open square — all as Prolog clauses
- **Board as a list**: the 3x3 board is a 9-element Prolog list; moves use
  `replace/3` to produce new boards
- **Win detection**: `win(Board, Player)` checks all 8 lines via `line/3` facts
- **Reactive UI**: board state drives SolidJS rendering; moves trigger
  re-queries for win/draw detection

## Files

| File | Description |
|------|-------------|
| `tictactoe-kb.js` | Knowledge base — game rules and AI strategy |
| `tictactoe.html` | Complete browser app (HTML + CSS + JS inlined) |

## Run

Open directly in a browser:

```bash
open examples/tictactoe/tictactoe.html
```
