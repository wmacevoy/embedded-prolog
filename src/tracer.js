// ============================================================
// tracer.js — Query tracer for PrologEngine
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
//
// Temporarily wraps engine.solve with an instrumented version
// that records structured trace entries, then restores the
// original after the query completes.
//
// Works in: Node 12+, Bun, Deno, QuickJS, Duktape, Hermes,
// all browsers (ES2015+ for Map), V8/JSC/SpiderMonkey shell.
// ============================================================

function _extractBindings(subst) {
  var bindings = {};
  subst.forEach(function(val, key) {
    // Only include user-visible variables (skip internal _V### vars)
    if (key.indexOf("_V") !== 0) {
      bindings[key] = _termSnap(val);
    }
  });
  return bindings;
}

function _termSnap(term) {
  if (!term) return null;
  if (term.type === "atom") return { type: "atom", name: term.name };
  if (term.type === "num") return { type: "num", value: term.value };
  if (term.type === "var") return { type: "var", name: term.name };
  if (term.type === "compound") {
    var args = [];
    for (var i = 0; i < term.args.length; i++) {
      args.push(_termSnap(term.args[i]));
    }
    return { type: "compound", functor: term.functor, args: args };
  }
  return null;
}

function trace(engine, goal, opts) {
  var options = opts || {};
  var maxSteps = (typeof options.maxSteps === "number") ? options.maxSteps : 1000;
  var maxResults = (typeof options.maxResults === "number") ? options.maxResults : 10;

  var steps = [];
  var results = [];
  var stepCount = { n: 0 };
  var stopped = { val: false };

  var originalSolve = engine.solve;

  engine.solve = function instrumentedSolve(goals, subst, counter, depth, onSolution) {
    if (stopped.val) return;
    if (goals.length === 0) {
      onSolution(subst);
      return;
    }

    var currentGoal = goals[0];
    var rest = goals.slice(1);
    var resolved = engine.deepWalk(currentGoal, subst);

    // Determine builtin key
    var key = null;
    if (resolved.type === "compound") key = resolved.functor + "/" + resolved.args.length;
    else if (resolved.type === "atom") key = resolved.name + "/0";

    if (key && engine.builtins[key]) {
      // Builtin invocation
      if (stepCount.n < maxSteps && !stopped.val) {
        steps.push({
          depth: depth,
          goal: _termSnap(resolved),
          action: "builtin",
          clauseIndex: null,
          bindings: _extractBindings(subst)
        });
        stepCount.n++;
      }
      if (stepCount.n >= maxSteps) { stopped.val = true; return; }

      engine.builtins[key](resolved, rest, subst, counter, depth, onSolution);
      return;
    }

    // User-defined clauses
    for (var i = 0; i < engine.clauses.length; i++) {
      if (stopped.val) return;

      // Record the "try" step
      if (stepCount.n < maxSteps) {
        steps.push({
          depth: depth,
          goal: _termSnap(resolved),
          action: "try",
          clauseIndex: i,
          bindings: null
        });
        stepCount.n++;
      }
      if (stepCount.n >= maxSteps) { stopped.val = true; return; }

      var fresh = engine._freshVars(engine.clauses[i], counter);
      var s = engine.unify(resolved, fresh.head, subst);

      if (s !== null) {
        // Unification succeeded
        if (stepCount.n < maxSteps) {
          steps.push({
            depth: depth,
            goal: _termSnap(resolved),
            action: "unify_ok",
            clauseIndex: i,
            bindings: _extractBindings(s)
          });
          stepCount.n++;
        }
        if (stepCount.n >= maxSteps) { stopped.val = true; return; }

        var newGoals = fresh.body.concat(rest);
        instrumentedSolve(newGoals, s, counter, depth + 1, onSolution);
      } else {
        // Unification failed
        if (stepCount.n < maxSteps) {
          steps.push({
            depth: depth,
            goal: _termSnap(resolved),
            action: "unify_fail",
            clauseIndex: i,
            bindings: null
          });
          stepCount.n++;
        }
        if (stepCount.n >= maxSteps) { stopped.val = true; return; }
      }
    }
  };

  // Run the query using the instrumented solve
  var counter = { n: 0 };
  try {
    engine.solve([goal], new Map(), counter, 0, function(subst) {
      if (stopped.val) return;
      var resolved = engine.deepWalk(goal, subst);

      if (stepCount.n < maxSteps) {
        steps.push({
          depth: 0,
          goal: _termSnap(resolved),
          action: "solution",
          clauseIndex: null,
          bindings: _extractBindings(subst)
        });
        stepCount.n++;
      }

      results.push(resolved);
      if (results.length >= maxResults) {
        stopped.val = true;
      }
    });
  } finally {
    // Always restore the original solve
    engine.solve = originalSolve;
  }

  return {
    goal: _termSnap(goal),
    results: results,
    steps: steps
  };
}

// ── Export (dual ESM/CJS) ─────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.trace = trace;
}
export { trace };
