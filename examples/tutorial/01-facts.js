// ============================================================
// 01-facts.js — Facts and queries
//
// A smart thermostat knows about rooms and their temperatures.
// We add facts and ask questions.
//
// Run:  node examples/tutorial/01-facts.js
//       qjs --module examples/tutorial/01-facts.js
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
`);

// ── Queries ─────────────────────────────────────────────────

// What rooms exist?
var rooms = e.query(parseTerm("room(R)"));
// rooms = [room(kitchen), room(bedroom), room(garage)]

// What is the kitchen temperature?
var kitchenTemp = e.queryFirst(parseTerm("temperature(kitchen, T)"));
// kitchenTemp = temperature(kitchen, 72)

// All temperature facts
var allTemps = e.query(parseTerm("temperature(R, T)"));

var _print = (typeof print !== "undefined") ? print : console.log.bind(console);
_print("Rooms: " + rooms.length);
_print("Kitchen temp: " + kitchenTemp.args[1].value);
_print("All temps: " + allTemps.length);
