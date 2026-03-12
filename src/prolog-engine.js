// ============================================================
// prolog-engine.js — Mini Prolog Interpreter
//
// Portable: no let/const, no arrows, no for-of, no generators,
// no template literals, no destructuring, no spread.
// Map copy uses explicit iteration for maximum compatibility.
//
// Works in: Node 12+, Bun, Deno, QuickJS, Duktape, Hermes,
// all browsers (ES2015+ for Map), V8/JSC/SpiderMonkey shell.
// ============================================================

function _copyMap(m) {
  var copy = new Map();
  m.forEach(function(val, key) { copy.set(key, val); });
  return copy;
}

function PrologEngine() {
  this.clauses = [];
  this.builtins = {};
  this._output = [];
  this._registerBuiltins();
}

// ── Term constructors ─────────────────────────────────────────

PrologEngine.atom = function(name) { return { type: "atom", name: name }; };
PrologEngine.variable = function(name) { return { type: "var", name: name }; };
PrologEngine.compound = function(functor, args) { return { type: "compound", functor: functor, args: args }; };
PrologEngine.num = function(n) { return { type: "num", value: n }; };

PrologEngine.list = function(items, tail) {
  var l = tail || PrologEngine.atom("[]");
  for (var i = items.length - 1; i >= 0; i--) {
    l = PrologEngine.compound(".", [items[i], l]);
  }
  return l;
};

// ── Substitution / unification ────────────────────────────────

PrologEngine.prototype.walk = function(term, subst) {
  while (term && term.type === "var" && subst.has(term.name)) {
    term = subst.get(term.name);
  }
  return term;
};

PrologEngine.prototype.deepWalk = function(term, subst) {
  term = this.walk(term, subst);
  if (!term) return term;
  if (term.type === "compound") {
    var args = [];
    for (var i = 0; i < term.args.length; i++) {
      args.push(this.deepWalk(term.args[i], subst));
    }
    return PrologEngine.compound(term.functor, args);
  }
  return term;
};

PrologEngine.prototype.unify = function(a, b, subst) {
  a = this.walk(a, subst);
  b = this.walk(b, subst);
  if (!a || !b) return null;
  if (a.type === "var") { var s = _copyMap(subst); s.set(a.name, b); return s; }
  if (b.type === "var") { var s = _copyMap(subst); s.set(b.name, a); return s; }
  if (a.type === "atom" && b.type === "atom" && a.name === b.name) return subst;
  if (a.type === "num"  && b.type === "num"  && a.value === b.value) return subst;
  if (a.type === "compound" && b.type === "compound" &&
      a.functor === b.functor && a.args.length === b.args.length) {
    var s = subst;
    for (var i = 0; i < a.args.length; i++) {
      s = this.unify(a.args[i], b.args[i], s);
      if (s === null) return null;
    }
    return s;
  }
  return null;
};

// ── Clause management ─────────────────────────────────────────

PrologEngine.prototype.addClause = function(head, body) {
  this.clauses.push({ head: head, body: body || [] });
};

PrologEngine.prototype.retractFirst = function(head) {
  for (var i = 0; i < this.clauses.length; i++) {
    var fresh = this._freshVars(this.clauses[i], { n: 9000 });
    if (this.unify(head, fresh.head, new Map()) !== null) {
      this.clauses.splice(i, 1);
      return true;
    }
  }
  return false;
};

PrologEngine.prototype._freshVars = function(clause, counter) {
  var mapping = {};
  function rename(term) {
    if (!term) return term;
    if (term.type === "var") {
      if (!mapping[term.name]) mapping[term.name] = PrologEngine.variable("_V" + (counter.n++));
      return mapping[term.name];
    }
    if (term.type === "compound") {
      var args = [];
      for (var i = 0; i < term.args.length; i++) args.push(rename(term.args[i]));
      return PrologEngine.compound(term.functor, args);
    }
    return term;
  }
  var newBody = [];
  for (var i = 0; i < clause.body.length; i++) newBody.push(rename(clause.body[i]));
  return { head: rename(clause.head), body: newBody };
};

// ── Solver (CPS, no generators) ───────────────────────────────

PrologEngine.prototype.solve = function(goals, subst, counter, depth, onSolution) {
  if (depth > 300) return;
  if (goals.length === 0) { onSolution(subst); return; }

  var goal = goals[0];
  var rest = goals.slice(1);
  var resolved = this.deepWalk(goal, subst);

  var key = null;
  if (resolved.type === "compound") key = resolved.functor + "/" + resolved.args.length;
  else if (resolved.type === "atom") key = resolved.name + "/0";

  if (key && this.builtins[key]) {
    this.builtins[key](resolved, rest, subst, counter, depth, onSolution);
    return;
  }

  for (var i = 0; i < this.clauses.length; i++) {
    var fresh = this._freshVars(this.clauses[i], counter);
    var s = this.unify(resolved, fresh.head, subst);
    if (s !== null) {
      var newGoals = fresh.body.concat(rest);
      this.solve(newGoals, s, counter, depth + 1, onSolution);
    }
  }
};

// ── Public query API ──────────────────────────────────────────

PrologEngine.prototype.query = function(goal, limit) {
  var max = limit || 50;
  var counter = { n: 0 };
  var results = [];
  var self = this;
  this.solve([goal], new Map(), counter, 0, function(subst) {
    results.push(self.deepWalk(goal, subst));
  });
  return results.slice(0, max);
};

PrologEngine.prototype.queryFirst = function(goal) {
  var counter = { n: 0 };
  var self = this;
  var FOUND = {};
  try {
    this.solve([goal], new Map(), counter, 0, function(subst) {
      FOUND.result = self.deepWalk(goal, subst);
      throw FOUND;
    });
  } catch (e) {
    if (e === FOUND) return FOUND.result;
    throw e;
  }
  return null;
};

PrologEngine.prototype.queryWithOutput = function(goal) {
  this._output = [];
  var result = this.queryFirst(goal);
  var output = this._output.slice();
  this._output = [];
  return { result: result, output: output };
};

// ── Builtins ──────────────────────────────────────────────────

PrologEngine.prototype._registerBuiltins = function() {
  var self = this;

  this.builtins["not/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    var inner = self.deepWalk(goal.args[0], subst);
    var found = false;
    var savedN = counter.n;
    self.solve([inner], subst, counter, depth + 1, function() { found = true; });
    counter.n = savedN;
    if (!found) self.solve(rest, subst, counter, depth + 1, onSolution);
  };
  this.builtins["\\+/1"] = this.builtins["not/1"];

  this.builtins["=/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var s = self.unify(goal.args[0], goal.args[1], subst);
    if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
  };

  this.builtins["\\=/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var s = self.unify(goal.args[0], goal.args[1], subst);
    if (s === null) self.solve(rest, subst, counter, depth + 1, onSolution);
  };

  this.builtins["member/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var elem = goal.args[0];
    var list = self.deepWalk(goal.args[1], subst);
    while (list && list.type === "compound" && list.functor === "." && list.args.length === 2) {
      var s = self.unify(elem, list.args[0], subst);
      if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
      list = self.deepWalk(list.args[1], subst);
    }
  };

  this.builtins["nth1/3"] = function(goal, rest, subst, counter, depth, onSolution) {
    var idxTerm = self.deepWalk(goal.args[0], subst);
    var list = self.deepWalk(goal.args[1], subst);
    var elem = goal.args[2];
    var i = 1;
    while (list && list.type === "compound" && list.functor === "." && list.args.length === 2) {
      if (idxTerm.type === "num") {
        if (i === idxTerm.value) {
          var s = self.unify(elem, list.args[0], subst);
          if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
          return;
        }
      } else {
        var s = self.unify(idxTerm, PrologEngine.num(i), subst);
        if (s !== null) {
          s = self.unify(elem, list.args[0], s);
          if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
        }
      }
      list = self.deepWalk(list.args[1], subst);
      i++;
    }
  };

  this.builtins["replace/4"] = function(goal, rest, subst, counter, depth, onSolution) {
    var list = self.deepWalk(goal.args[0], subst);
    var idx = self.deepWalk(goal.args[1], subst);
    var val = self.deepWalk(goal.args[2], subst);
    var result = goal.args[3];
    if (idx.type !== "num") return;
    var items = [];
    while (list && list.type === "compound" && list.functor === "." && list.args.length === 2) {
      items.push(list.args[0]);
      list = self.deepWalk(list.args[1], subst);
    }
    if (idx.value < 1 || idx.value > items.length) return;
    var newItems = items.slice();
    newItems[idx.value - 1] = val;
    var s = self.unify(result, PrologEngine.list(newItems), subst);
    if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
  };

  this.builtins["is/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var lhs = goal.args[0];
    var rhs = self.deepWalk(goal.args[1], subst);
    var val = _evalArith(rhs);
    if (val !== null) {
      var s = self.unify(lhs, PrologEngine.num(val), subst);
      if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
    }
  };

  // Comparison operators (registered via loop, IIFE for closure)
  var comparisons = [
    [">/2",   function(a,b) { return a > b; }],
    ["</2",   function(a,b) { return a < b; }],
    [">=/2",  function(a,b) { return a >= b; }],
    ["=</2",  function(a,b) { return a <= b; }],
    ["=:=/2", function(a,b) { return a === b; }],
    ["=\\=/2",function(a,b) { return a !== b; }]
  ];
  for (var ci = 0; ci < comparisons.length; ci++) {
    (function(op, fn) {
      self.builtins[op] = function(goal, rest, subst, counter, depth, onSolution) {
        var a = _evalArith(self.deepWalk(goal.args[0], subst));
        var b = _evalArith(self.deepWalk(goal.args[1], subst));
        if (a !== null && b !== null && fn(a, b))
          self.solve(rest, subst, counter, depth + 1, onSolution);
      };
    })(comparisons[ci][0], comparisons[ci][1]);
  }

  this.builtins["==/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    if (_termEq(self.deepWalk(goal.args[0], subst), self.deepWalk(goal.args[1], subst)))
      self.solve(rest, subst, counter, depth + 1, onSolution);
  };

  this.builtins["\\==/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    if (!_termEq(self.deepWalk(goal.args[0], subst), self.deepWalk(goal.args[1], subst)))
      self.solve(rest, subst, counter, depth + 1, onSolution);
  };

  this.builtins["true/0"] = function(goal, rest, subst, counter, depth, onSolution) {
    self.solve(rest, subst, counter, depth + 1, onSolution);
  };
  this.builtins["fail/0"] = function() {};

  this.builtins[",/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    self.solve([goal.args[0], goal.args[1]].concat(rest), subst, counter, depth + 1, onSolution);
  };

  this.builtins[";/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var left = self.deepWalk(goal.args[0], subst);
    var right = self.deepWalk(goal.args[1], subst);
    if (left.type === "compound" && left.functor === "->" && left.args.length === 2) {
      var found = false;
      self.solve([left.args[0]], subst, counter, depth + 1, function(s) {
        if (!found) { found = true; self.solve([left.args[1]].concat(rest), s, counter, depth + 1, onSolution); }
      });
      if (!found) self.solve([right].concat(rest), subst, counter, depth + 1, onSolution);
    } else {
      self.solve([left].concat(rest), subst, counter, depth + 1, onSolution);
      self.solve([right].concat(rest), subst, counter, depth + 1, onSolution);
    }
  };

  this.builtins["->/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var found = false;
    self.solve([goal.args[0]], subst, counter, depth + 1, function(s) {
      if (!found) { found = true; self.solve([goal.args[1]].concat(rest), s, counter, depth + 1, onSolution); }
    });
  };

  this.builtins["assert/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    self.clauses.push({ head: self.deepWalk(goal.args[0], subst), body: [] });
    self.solve(rest, subst, counter, depth + 1, onSolution);
  };
  this.builtins["assertz/1"] = this.builtins["assert/1"];

  this.builtins["retract/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    if (self.retractFirst(self.deepWalk(goal.args[0], subst)))
      self.solve(rest, subst, counter, depth + 1, onSolution);
  };

  this.builtins["findall/3"] = function(goal, rest, subst, counter, depth, onSolution) {
    var template = goal.args[0];
    var qGoal = self.deepWalk(goal.args[1], subst);
    var bag = goal.args[2];
    var results = [];
    var savedN = counter.n;
    self.solve([qGoal], subst, counter, depth + 1, function(s) {
      results.push(self.deepWalk(template, s));
    });
    counter.n = savedN;
    var s = self.unify(bag, PrologEngine.list(results), subst);
    if (s !== null) self.solve(rest, s, counter, depth + 1, onSolution);
  };

  this.builtins["write/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    self._output.push(termToString(self.deepWalk(goal.args[0], subst)));
    self.solve(rest, subst, counter, depth + 1, onSolution);
  };
  this.builtins["writeln/1"] = function(goal, rest, subst, counter, depth, onSolution) {
    self._output.push(termToString(self.deepWalk(goal.args[0], subst)) + "\n");
    self.solve(rest, subst, counter, depth + 1, onSolution);
  };
  this.builtins["nl/0"] = function(goal, rest, subst, counter, depth, onSolution) {
    self._output.push("\n");
    self.solve(rest, subst, counter, depth + 1, onSolution);
  };
};

// ── Internal helpers ──────────────────────────────────────────

function _evalArith(term) {
  if (!term) return null;
  if (term.type === "num") return term.value;
  if (term.type === "compound") {
    var f = term.functor, a = term.args;
    if (f === "+" && a.length === 2) { var x = _evalArith(a[0]), y = _evalArith(a[1]); return x !== null && y !== null ? x + y : null; }
    if (f === "-" && a.length === 2) { var x = _evalArith(a[0]), y = _evalArith(a[1]); return x !== null && y !== null ? x - y : null; }
    if (f === "*" && a.length === 2) { var x = _evalArith(a[0]), y = _evalArith(a[1]); return x !== null && y !== null ? x * y : null; }
    if (f === "//" && a.length === 2) { var x = _evalArith(a[0]), y = _evalArith(a[1]); return x !== null && y !== null && y !== 0 ? Math.trunc(x/y) : null; }
    if (f === "mod" && a.length === 2) { var x = _evalArith(a[0]), y = _evalArith(a[1]); return x !== null && y !== null && y !== 0 ? x % y : null; }
    if (f === "abs" && a.length === 1) { var x = _evalArith(a[0]); return x !== null ? Math.abs(x) : null; }
    if (f === "-" && a.length === 1) { var x = _evalArith(a[0]); return x !== null ? -x : null; }
  }
  return null;
}

function _termEq(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "atom") return a.name === b.name;
  if (a.type === "num")  return a.value === b.value;
  if (a.type === "var")  return a.name === b.name;
  if (a.type === "compound") {
    if (a.functor !== b.functor || a.args.length !== b.args.length) return false;
    for (var i = 0; i < a.args.length; i++) {
      if (!_termEq(a.args[i], b.args[i])) return false;
    }
    return true;
  }
  return false;
}

// ── Utility ───────────────────────────────────────────────────

function termToString(term) {
  if (!term) return "?";
  if (term.type === "atom") return term.name;
  if (term.type === "num")  return String(term.value);
  if (term.type === "var")  return term.name;
  if (term.type === "compound") {
    if (term.functor === "." && term.args.length === 2) {
      var items = [], cur = term;
      while (cur.type === "compound" && cur.functor === "." && cur.args.length === 2) {
        items.push(termToString(cur.args[0]));
        cur = cur.args[1];
      }
      if (cur.type === "atom" && cur.name === "[]") return "[" + items.join(",") + "]";
      return "[" + items.join(",") + "|" + termToString(cur) + "]";
    }
    var strs = [];
    for (var i = 0; i < term.args.length; i++) strs.push(termToString(term.args[i]));
    return term.functor + "(" + strs.join(",") + ")";
  }
  return "?";
}

function listToArray(term) {
  var items = [];
  while (term && term.type === "compound" && term.functor === "." && term.args.length === 2) {
    items.push(term.args[0]);
    term = term.args[1];
  }
  return items;
}

// ── Export (dual ESM/CJS) ─────────────────────────────────────

if (typeof exports !== "undefined") {
  exports.PrologEngine = PrologEngine;
  exports.termToString = termToString;
  exports.listToArray = listToArray;
}
export { PrologEngine, termToString, listToArray };
