// ============================================================
// y8-loader.js — Load Prolog text into Y8 Datalog (ES5)
//
// Uses parser.js to parse Prolog text, then calls y8-datalog API.
//
// Portable: no let/const, no arrows, no for-of.
//
// Usage:
//   var db = y8Datalog(sqliteDb);
//   db.setup();
//   y8LoadProgram(db, "parent(alice, bob). parent(bob, carol).");
// ============================================================

import { parseProgram } from './parser.js';

function _termToDatalog(term) {
  // Convert parser term objects to y8-datalog format:
  // atoms → strings, vars → Unbound, compounds → [functor, ...args], nums → values
  if (!term) return null;
  if (term.type === "atom") return term.name;
  if (term.type === "var") return { $qjson: "unbound", name: term.name === "_" ? "" : term.name };
  if (term.type === "num") return term.repr || term.value;
  if (term.type === "compound") {
    var result = [term.functor];
    for (var i = 0; i < term.args.length; i++) {
      result.push(_termToDatalog(term.args[i]));
    }
    return result;
  }
  if (term.type === "object") {
    var obj = {};
    for (var i = 0; i < term.pairs.length; i++) {
      obj[term.pairs[i].key] = _termToDatalog(term.pairs[i].value);
    }
    return obj;
  }
  return term;
}

function _goalToArray(term) {
  // Convert a compound term to [functor, arg1, arg2, ...]
  if (term.type === "compound") {
    var result = [term.functor];
    for (var i = 0; i < term.args.length; i++) {
      result.push(_termToDatalog(term.args[i]));
    }
    return result;
  }
  if (term.type === "atom") {
    return [term.name];
  }
  return _termToDatalog(term);
}

function y8LoadProgram(db, text) {
  var clauses = parseProgram(text);
  var count = 0;

  for (var i = 0; i < clauses.length; i++) {
    var head = clauses[i].head;
    var body = clauses[i].body;

    if (body.length === 0) {
      // Fact: assert it
      if (head.type === "compound") {
        var functor = head.functor;
        var args = [];
        for (var j = 0; j < head.args.length; j++) {
          args.push(_termToDatalog(head.args[j]));
        }
        db.assertFact(functor, args);
      }
    } else {
      // Rule: add it
      var clause = [_goalToArray(head)];
      for (var j = 0; j < body.length; j++) {
        clause.push(_goalToArray(body[j]));
      }
      db.addRule(clause);
    }
    count++;
  }
  return count;
}

function y8LoadString(db, text) {
  return y8LoadProgram(db, text);
}

// ── Export ───────────────────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.y8LoadProgram = y8LoadProgram;
  exports.y8LoadString = y8LoadString;
}
export { y8LoadProgram, y8LoadString };
