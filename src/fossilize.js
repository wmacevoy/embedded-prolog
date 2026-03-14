// ============================================================
// fossilize.js — Freeze a Prolog engine's clause database
// mineralize.js — Selectively lock specific predicates
//
// Two modes of hardening:
//
//   mineralize(engine, "react", 0)
//     → react/0 is immutable.  Everything else stays dynamic.
//     → Additive, one-way.  Call multiple times for multiple preds.
//
//   fossilize(engine)
//     → ALL clauses frozen.  Only ephemeral survives.
//     → Terminal.  Nothing changes after this.
//
// Portable: ES5, no dependencies.
// ============================================================

// ── Helpers ──────────────────────────────────────────────────

function _predKey(term) {
  if (!term) return null;
  if (term.type === "compound") return term.functor + "/" + term.args.length;
  if (term.type === "atom") return term.name + "/0";
  return null;
}

// ── mineralize ──────────────────────────────────────────────

function mineralize(engine, functor, arity) {
  // Initialize mineralized set if needed
  if (!engine.mineralized) {
    engine.mineralized = {};
    _installMineralizeGuards(engine);
  }
  engine.mineralized[functor + "/" + arity] = true;
}

function _installMineralizeGuards(engine) {
  // Guard addClause
  var origAdd = engine.addClause.bind(engine);
  engine.addClause = function(head, body) {
    var key = _predKey(head);
    if (key && engine.mineralized[key]) return;
    origAdd(head, body);
  };

  // Guard retractFirst
  var origRetract = engine.retractFirst.bind(engine);
  engine.retractFirst = function(head) {
    var key = _predKey(head);
    if (key && engine.mineralized[key]) return false;
    return origRetract(head);
  };

  // Guard assert/1
  var origAssert = engine.builtins["assert/1"];
  engine.builtins["assert/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    var key = _predKey(term);
    if (key && engine.mineralized[key]) return; // fail
    origAssert(goal, rest, subst, counter, depth, onSolution);
  };

  // Guard assertz/1 (alias)
  var origAssertz = engine.builtins["assertz/1"];
  if (origAssertz) {
    engine.builtins["assertz/1"] = function(goal, rest, subst, counter, depth, onSolution) {
      var term = engine.deepWalk(goal.args[0], subst);
      var key = _predKey(term);
      if (key && engine.mineralized[key]) return;
      origAssertz(goal, rest, subst, counter, depth, onSolution);
    };
  }

  // Guard retract/1
  var origRetractBuiltin = engine.builtins["retract/1"];
  engine.builtins["retract/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    var key = _predKey(term);
    if (key && engine.mineralized[key]) return;
    origRetractBuiltin(goal, rest, subst, counter, depth, onSolution);
  };

  // Guard retractall/1
  var origRetractAll = engine.builtins["retractall/1"];
  engine.builtins["retractall/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    var key = _predKey(term);
    if (key && engine.mineralized[key]) return;
    origRetractAll(goal, rest, subst, counter, depth, onSolution);
  };

  // Guard ephemeral/1 (if registered)
  if (engine.builtins["ephemeral/1"]) {
    var origEph = engine.builtins["ephemeral/1"];
    engine.builtins["ephemeral/1"] = function(goal, rest, subst, counter, depth, onSolution) {
      var term = engine.deepWalk(goal.args[0], subst);
      var key = _predKey(term);
      if (key && engine.mineralized[key]) return;
      origEph(goal, rest, subst, counter, depth, onSolution);
    };
  }

  // mineralize/1 builtin — callable from Prolog
  engine.builtins["mineralize/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var term = engine.deepWalk(goal.args[0], subst);
    if (term.type === "compound" && term.functor === "/" && term.args.length === 2) {
      var f = term.args[0];
      var a = term.args[1];
      if (f.type === "atom" && a.type === "num") {
        engine.mineralized[f.name + "/" + a.value] = true;
      }
    }
    engine.solve(rest, subst, counter, depth + 1, onSolution);
  };
}

// ── fossilize ───────────────────────────────────────────────

function fossilize(engine) {
  var boundary = engine.clauses.length;

  // ── Disable permanent mutation builtins (goal fails) ─────
  function _fail() {}  // no solutions — goal fails in Prolog

  engine.builtins["assert/1"] = _fail;
  engine.builtins["assertz/1"] = _fail;
  engine.builtins["retract/1"] = _fail;
  engine.builtins["retractall/1"] = _fail;

  // ── Disable programmatic additions ───────────────────────
  engine.addClause = function() {};

  // ── retractFirst: ephemeral zone only (>= boundary) ──────
  engine.retractFirst = function(head) {
    for (var i = boundary; i < engine.clauses.length; i++) {
      var ch = engine.clauses[i].head;
      var cb = engine.clauses[i].body;
      if (engine.unify(head, ch, new Map()) !== null) {
        engine.clauses.splice(i, 1);
        if (cb.length === 0) {
          for (var j = 0; j < engine.onRetract.length; j++)
            engine.onRetract[j](ch);
        }
        return true;
      }
    }
    return false;
  };

  return boundary;
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.fossilize = fossilize;
  exports.mineralize = mineralize;
}
export { fossilize, mineralize };
