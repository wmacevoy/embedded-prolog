// ============================================================
// todo-kb.js — Shared todo knowledge base
//
// Imported by both server and client. Rules are code (shared),
// facts are data (synced). This file defines only rules.
//
// Dynamic facts (synced at runtime):
//   todo(Id, Text, Status, Owner)
//     Id:     string atom (timestamp)
//     Text:   string atom
//     Status: active | done
//     Owner:  string atom (client name)
// ============================================================

function buildTodoKB(PrologEngine) {
  const e = new PrologEngine();
  const at = PrologEngine.atom, v = PrologEngine.variable,
        c = PrologEngine.compound, n = PrologEngine.num;

  // ── Derived rules (shared logic) ──────────────────────────

  // todo_count(Active, Done)
  e.addClause(c("todo_count", [v("A"), v("D")]), [
    c("findall", [at("x"),
      c("todo", [v("_I"), v("_T"), at("active"), v("_O")]),
      v("AL")]),
    c("list_length", [v("AL"), v("A")]),
    c("findall", [at("x"),
      c("todo", [v("_I2"), v("_T2"), at("done"), v("_O2")]),
      v("DL")]),
    c("list_length", [v("DL"), v("D")])
  ]);

  // all_done :- \+ todo(_, _, active, _).
  e.addClause(c("all_done", []), [
    c("not", [c("todo", [v("_I"), v("_T"), at("active"), v("_O")])])
  ]);

  // ── Builtins ──────────────────────────────────────────────

  e.builtins["list_length/2"] = function(g, r, s, ctr, d, cb) {
    var lst = e.deepWalk(g.args[0], s);
    var items = [];
    while (lst && lst.type === "compound" && lst.functor === "." && lst.args.length === 2) {
      items.push(lst.args[0]);
      lst = lst.args[1];
    }
    var u = e.unify(g.args[1], PrologEngine.num(items.length), s);
    if (u !== null) e.solve(r, u, ctr, d + 1, cb);
  };

  return e;
}

if (typeof exports !== "undefined") {
  exports.buildTodoKB = buildTodoKB;
}
export { buildTodoKB };
