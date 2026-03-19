// ============================================================
// 02-rules.js — Rules with body goals
//
// Rules derive new knowledge from existing facts.
// A rule has a head (the conclusion) and a body (the conditions).
//
// Run:  node examples/tutorial/02-rules.js
//       qjs --module examples/tutorial/02-rules.js
// ============================================================

import { PrologEngine, termToString } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { parseTerm } from "../../src/parser.js";

var e = new PrologEngine();

// ── Facts ───────────────────────────────────────────────────

loadString(e, `
  room(kitchen).
  room(bedroom).
  room(garage).

  temperature(kitchen, 72).
  temperature(bedroom, 68).
  temperature(garage, 55).

  target_temp(kitchen, 70).
  target_temp(bedroom, 72).
  target_temp(garage, 50).
`);

// ── Rules ───────────────────────────────────────────────────

loadString(e, `
  cold(Room) :- temperature(Room, T), T < 65.
  needs_heating(Room) :- temperature(Room, T), target_temp(Room, Target), T < Target.
`);

// ── Queries ─────────────────────────────────────────────────

var coldRooms = e.query(parseTerm("cold(R)"));
// Only garage (55 < 65)

var heatingNeeded = e.query(parseTerm("needs_heating(R)"));
// bedroom (68 < 72) — kitchen is fine (72 >= 70), garage is fine (55 >= 50)

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Cold rooms: " + coldRooms.length);
for (var i = 0; i < coldRooms.length; i++) {
  _print("  " + termToString(coldRooms[i]));
}
_print("Needs heating: " + heatingNeeded.length);
for (var i = 0; i < heatingNeeded.length; i++) {
  _print("  " + heatingNeeded[i].args[0].name);
}
