// ============================================================
// Tic-Tac-Toe Knowledge Base
//
// Rules are expressed in Prolog syntax and loaded via the
// parser/loader, making them dramatically more readable than
// the previous manual compound/atom/variable constructor calls.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";

const TICTACTOE_RULES = `
% ── Winning lines ────────────────────────────────────────
line(1, 2, 3).
line(4, 5, 6).
line(7, 8, 9).
line(1, 4, 7).
line(2, 5, 8).
line(3, 6, 9).
line(1, 5, 9).
line(3, 5, 7).

% ── Win detection ────────────────────────────────────────
win(Board, Player) :-
    line(A, B, C),
    nth1(A, Board, Player),
    nth1(B, Board, Player),
    nth1(C, Board, Player).

% ── Empty cell check ────────────────────────────────────
empty(Board, Pos) :-
    nth1(Pos, Board, e).

% ── Make a move ──────────────────────────────────────────
move(Board, Pos, Player, NewBoard) :-
    empty(Board, Pos),
    replace(Board, Pos, Player, NewBoard).

% ── Board full (no empty cells) ─────────────────────────
board_full(Board) :-
    not(member(e, Board)).

% ── Can a player win in one move? ───────────────────────
can_win(Board, Player, Pos) :-
    empty(Board, Pos),
    move(Board, Pos, Player, NB),
    win(NB, Player).

% ── AI move selection (clause order = priority) ─────────
% 1. Win if possible
choose_move(Board, Player, Pos) :-
    can_win(Board, Player, Pos).

% 2. Block opponent's winning move
choose_move(Board, Player, Pos) :-
    opponent(Player, Opp),
    can_win(Board, Opp, Pos).

% 3. Take center
choose_move(Board, _P, 5) :-
    empty(Board, 5).

% 4. Take a corner
choose_move(Board, _P, Pos) :-
    member(Pos, [1, 3, 7, 9]),
    empty(Board, Pos).

% 5. Take an edge
choose_move(Board, _P, Pos) :-
    member(Pos, [2, 4, 6, 8]),
    empty(Board, Pos).

% ── Opponent mapping ────────────────────────────────────
opponent(x, o).
opponent(o, x).
`;

export const TICTACTOE_PROLOG_SOURCE = TICTACTOE_RULES;

export function buildTicTacToeKB() {
  const engine = new PrologEngine();
  loadString(engine, TICTACTOE_RULES);
  return engine;
}

export function boardToProlog(board) {
  return PrologEngine.list(
    board.map(cell => cell === null ? PrologEngine.atom("e") : PrologEngine.atom(cell))
  );
}
