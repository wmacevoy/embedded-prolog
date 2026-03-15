// ============================================================
// serve.js — HTTP request handler over y8 Prolog
//
// REST requests are ephemeral facts.  Routes are Prolog rules.
// The framework is glue.
//
//   var h = createHandler(engine);
//   var res = h.handleRequest("post", "/api/trade", {symbol:"btc"});
//   // → { status: 200, body: ..., sends: [...] }
//
// Plug into any HTTP server (Node http, Bun.serve, Lambda).
//
// Prolog rules:
//   handle(get, '/api/health', _Body, response(200, ok)).
//   handle(post, '/api/price', Body, Response) :-
//       field(Body, symbol, Symbol), ...
//
// Portable: ES5 style (var, function, no arrows).
// ============================================================

import { PrologEngine, termToString, listToArray } from "./prolog-engine.js";

// ── JSON ↔ Prolog term conversion ───────────────────────────

function _jsonToTerm(v) {
  if (v === null || v === undefined) return PrologEngine.atom("null");
  if (v === true) return PrologEngine.atom("true");
  if (v === false) return PrologEngine.atom("false");
  if (typeof v === "number") return PrologEngine.num(v);
  if (typeof v === "string") {
    // Check for QJSON BigNum strings like "67000M"
    var m = v.match(/^(-?\d+\.?\d*)[NMLnml]$/);
    if (m) {
      var suffix = v.charAt(v.length - 1).toUpperCase();
      return PrologEngine.num(Number(m[1]), m[1] + suffix);
    }
    return PrologEngine.atom(v);
  }
  if (Array.isArray(v)) {
    var items = [];
    for (var i = 0; i < v.length; i++) items.push(_jsonToTerm(v[i]));
    return PrologEngine.list(items);
  }
  if (typeof v === "object") {
    var pairs = [];
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      pairs.push(PrologEngine.compound("-", [PrologEngine.atom(keys[i]), _jsonToTerm(v[keys[i]])]));
    }
    return PrologEngine.compound("obj", [PrologEngine.list(pairs)]);
  }
  return PrologEngine.atom(String(v));
}

function _termToJson(t) {
  if (!t) return null;
  if (t.type === "num") return t.value;
  if (t.type === "atom") {
    if (t.name === "null") return null;
    if (t.name === "true") return true;
    if (t.name === "false") return false;
    if (t.name === "[]") return [];
    return t.name;
  }
  if (t.type === "compound") {
    // obj([k:v, ...]) → JS object
    if (t.functor === "obj" && t.args.length === 1) {
      var pairs = listToArray(t.args[0]);
      var obj = {};
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].type === "compound" && pairs[i].functor === "-" && pairs[i].args.length === 2) {
          obj[_termToJson(pairs[i].args[0])] = _termToJson(pairs[i].args[1]);
        }
      }
      return obj;
    }
    // response(Status, Body) → handled by caller
    // list → array
    if (t.functor === "." && t.args.length === 2) {
      var items = listToArray(t);
      var arr = [];
      for (var i = 0; i < items.length; i++) arr.push(_termToJson(items[i]));
      return arr;
    }
    // other compound → {functor, args}
    var args = [];
    for (var i = 0; i < t.args.length; i++) args.push(_termToJson(t.args[i]));
    var r = {}; r[t.functor] = args.length === 1 ? args[0] : args;
    return r;
  }
  return null;
}

function _splitPath(str) {
  var parts = str.split("/");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] !== "") out.push(parts[i]);
  }
  return out;
}

// ── Handler factory ─────────────────────────────────────────

function createHandler(engine, options) {
  var _parse = (options && options.parse) || JSON.parse;
  var _stringify = (options && options.stringify) || JSON.stringify;
  var _onSends = (options && options.onSends) || null;

  // Register path_segments/2 builtin
  engine.builtins["path_segments/2"] = function(goal, rest, subst, counter, depth, onSolution) {
    var pathTerm = engine.deepWalk(goal.args[0], subst);
    if (pathTerm.type === "atom") {
      var segs = _splitPath(pathTerm.name);
      var segTerms = [];
      for (var i = 0; i < segs.length; i++) segTerms.push(PrologEngine.atom(segs[i]));
      var s = engine.unify(goal.args[1], PrologEngine.list(segTerms), subst);
      if (s !== null) engine.solve(rest, s, counter, depth + 1, onSolution);
    }
  };

  // Register field/3 builtin: field(obj([k:v,...]), Key, Value)
  engine.builtins["field/3"] = function(goal, rest, subst, counter, depth, onSolution) {
    var obj = engine.deepWalk(goal.args[0], subst);
    var key = engine.deepWalk(goal.args[1], subst);
    if (obj.type === "compound" && obj.functor === "obj" && obj.args.length === 1) {
      var pairs = listToArray(obj.args[0]);
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        if (p.type === "compound" && p.functor === "-" && p.args.length === 2) {
          var s = engine.unify(key, p.args[0], subst);
          if (s !== null) {
            var s2 = engine.unify(goal.args[2], p.args[1], s);
            if (s2 !== null) {
              engine.solve(rest, s2, counter, depth + 1, onSolution);
            }
          }
        }
      }
    }
  };

  function handleRequest(method, path, body) {
    // Normalize method to lowercase atom
    var methodAtom = PrologEngine.atom(method.toLowerCase());
    var pathAtom = PrologEngine.atom(path);

    // Convert body to Prolog term
    var bodyTerm;
    if (body === null || body === undefined) {
      bodyTerm = PrologEngine.atom("none");
    } else if (typeof body === "string") {
      try { bodyTerm = _jsonToTerm(_parse(body)); }
      catch(e) { bodyTerm = PrologEngine.atom(body); }
    } else {
      bodyTerm = _jsonToTerm(body);
    }

    var goal = PrologEngine.compound("handle",
      [methodAtom, pathAtom, bodyTerm, PrologEngine.variable("_Response")]);

    var result;
    try {
      result = engine.queryWithSends(goal);
    } catch(e) {
      return { status: 500, headers: { "Content-Type": "application/json" },
               body: _stringify({ error: "internal", message: String(e.message || e) }),
               sends: [] };
    }

    var sends = result.sends || [];
    if (_onSends && sends.length > 0) {
      _onSends(sends, { method: method, path: path });
    }

    if (!result.result) {
      return { status: 404, headers: { "Content-Type": "application/json" },
               body: _stringify({ error: "not_found" }), sends: sends };
    }

    // Extract response: response(Status, Body) or just a term
    var resp = result.result.args[3]; // the _Response variable after unification
    var status = 200;
    var respBody;

    if (resp && resp.type === "compound" && resp.functor === "response") {
      if (resp.args.length >= 1 && resp.args[0].type === "num") {
        status = resp.args[0].value;
      }
      respBody = resp.args.length >= 2 ? _termToJson(resp.args[1]) : null;
    } else {
      respBody = _termToJson(resp);
    }

    return { status: status, headers: { "Content-Type": "application/json" },
             body: _stringify(respBody), sends: sends };
  }

  function fossilHash(hashFn) {
    var parts = [];
    for (var i = 0; i < engine.clauses.length; i++) {
      var c = engine.clauses[i];
      parts.push(termToString(c.head));
      for (var j = 0; j < c.body.length; j++) {
        parts.push("  " + termToString(c.body[j]));
      }
    }
    var text = parts.join("\n");
    return hashFn ? hashFn(text) : text;
  }

  return {
    handleRequest: handleRequest,
    fossilHash: fossilHash
  };
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.createHandler = createHandler;
  exports._jsonToTerm = _jsonToTerm;
  exports._termToJson = _termToJson;
}
export { createHandler, _jsonToTerm, _termToJson };
