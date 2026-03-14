// ============================================================
// test-qsql.js — Tests for qsql.js per-predicate typed adapter
//
// Run:  node src/test-qsql.js
// Uses MockDB — no better-sqlite3 or bun:sqlite needed.
// ============================================================

import { PrologEngine } from './prolog-engine.js';
import { persist } from './persist.js';
import { qsqlAdapter, _qsql_tableName, _qsql_argVal, _qsql_safeName } from './qsql.js';

var atom = PrologEngine.atom;
var compound = PrologEngine.compound;
var variable = PrologEngine.variable;
var num = PrologEngine.num;

var passed = 0, failed = 0;

// ── MockDB: simulates better-sqlite3 for qsql tests ─────────

function MockDB() {
  this._tables = {};
}

MockDB.prototype.exec = function(sql) {
  var m = sql.match(/CREATE TABLE IF NOT EXISTS\s+(?:"([^"]+)"|(\w+))\s*\((.+)\)/);
  if (m) {
    var tbl = m[1] || m[2];
    if (!this._tables[tbl]) {
      var body = m[3];

      // Extract PK columns
      var pkCols = [];
      var pkMatch = body.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
      if (pkMatch) {
        var pkParts = pkMatch[1].split(",");
        for (var p = 0; p < pkParts.length; p++) pkCols.push(pkParts[p].trim());
      }

      // Remove standalone PRIMARY KEY constraint from column list
      var colPart = body.replace(/,\s*PRIMARY KEY\s*\([^)]*\)/i, "");
      var rawCols = colPart.split(",");
      var cols = [];
      for (var i = 0; i < rawCols.length; i++) {
        var parts = rawCols[i].trim().split(/\s+/);
        var colName = parts[0];
        cols.push(colName);
        // Inline PRIMARY KEY
        var hasInlinePK = false;
        for (var j = 0; j < parts.length; j++) {
          if (parts[j].toUpperCase() === "PRIMARY") { hasInlinePK = true; break; }
        }
        if (hasInlinePK) pkCols.push(colName);
      }

      // Map PK names to column indices
      var pkIndices = [];
      for (var i = 0; i < pkCols.length; i++) {
        for (var j = 0; j < cols.length; j++) {
          if (cols[j] === pkCols[i]) { pkIndices.push(j); break; }
        }
      }

      this._tables[tbl] = { cols: cols, pkIndices: pkIndices, rows: {} };
    }
  }
  // CREATE INDEX — no-op
};

MockDB.prototype.prepare = function(sql) {
  var self = this;

  // INSERT OR IGNORE INTO "tbl" VALUES (?, ?, ...)
  var im = sql.match(/INSERT OR IGNORE INTO\s+(?:"([^"]+)"|(\w+))/);
  if (im) {
    var tbl = im[1] || im[2];
    var stmt = {
      run: function() {
        var args = Array.prototype.slice.call(arguments);
        var table = self._tables[tbl];
        if (!table) return;
        var pk = "";
        for (var i = 0; i < table.pkIndices.length; i++) {
          pk += String(args[table.pkIndices[i]]) + "\0";
        }
        if (table.rows[pk]) return;
        var row = {};
        for (var i = 0; i < table.cols.length && i < args.length; i++) {
          row[table.cols[i]] = args[i];
        }
        table.rows[pk] = row;
      }
    };
    return stmt;
  }

  // DELETE FROM "tbl" WHERE col = ?
  var dm = sql.match(/DELETE FROM\s+(?:"([^"]+)"|(\w+))\s+WHERE\s+(\w+)\s*=\s*\?/);
  if (dm) {
    var tbl = dm[1] || dm[2];
    var col = dm[3];
    var stmt = {
      run: function(val) {
        var table = self._tables[tbl];
        if (!table) return;
        var toDelete = [];
        for (var pk in table.rows) {
          if (table.rows[pk][col] === val) toDelete.push(pk);
        }
        for (var i = 0; i < toDelete.length; i++) {
          delete table.rows[toDelete[i]];
        }
      }
    };
    return stmt;
  }

  // SELECT col1, col2 FROM "tbl"
  var sm = sql.match(/SELECT\s+(.+?)\s+FROM\s+(?:"([^"]+)"|(\w+))/);
  if (sm) {
    var colStr = sm[1];
    var tbl = sm[2] || sm[3];
    var selectCols = colStr.split(",");
    for (var i = 0; i < selectCols.length; i++) selectCols[i] = selectCols[i].trim();
    var stmt = {
      all: function() {
        var table = self._tables[tbl];
        if (!table) return [];
        var results = [];
        for (var pk in table.rows) {
          var row = table.rows[pk];
          var obj = {};
          for (var i = 0; i < selectCols.length; i++) {
            obj[selectCols[i]] = row[selectCols[i]];
          }
          results.push(obj);
        }
        return results;
      },
      run: function() {}
    };
    return stmt;
  }

  return { run: function() {}, all: function() { return []; } };
};

MockDB.prototype.close = function() {};

// ── Harness ─────────────────────────────────────────────────

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (e) {
    failed++;
    console.log("  \u2717 " + name + ": " + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Unit tests ──────────────────────────────────────────────

console.log("qsql.js");

test("safeName", function() {
  assert(_qsql_safeName("price") === "price");
  assert(_qsql_safeName("my-pred") === "my_pred");
  assert(_qsql_safeName("a.b.c") === "a_b_c");
});

test("tableName", function() {
  assert(_qsql_tableName("price", 2) === "q$price$2");
  assert(_qsql_tableName("color", 0) === "q$color$0");
  assert(_qsql_tableName("my-pred", 1) === "q$my_pred$1");
});

test("argVal atom", function() {
  assert(_qsql_argVal({ t: "a", n: "hello" }) === "hello");
});

test("argVal num", function() {
  assert(_qsql_argVal({ t: "n", v: 42 }) === 42);
  assert(_qsql_argVal({ t: "n", v: 3.14 }) === 3.14);
});

test("argVal null", function() {
  assert(_qsql_argVal(null) === null);
});

test("argVal compound → JSON", function() {
  var val = _qsql_argVal({ t: "c", f: "pair", a: [{ t: "n", v: 1 }] });
  assert(typeof val === "string");
  assert(val.indexOf("pair") >= 0);
});

// ── Integration tests: through persist ──────────────────────

test("facts survive restart", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.queryFirst(compound("assert", [compound("color", [atom("sky"), atom("blue")])]));
  e1.queryFirst(compound("assert", [compound("color", [atom("grass"), atom("green")])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var results = e2.query(compound("color", [variable("X"), variable("Y")]));
  assert(results.length === 2, "expected 2, got " + results.length);
});

test("retract removes from DB", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.queryFirst(compound("assert", [compound("x", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("x", [num(2)])]));
  e1.queryFirst(compound("retract", [compound("x", [num(1)])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var results = e2.query(compound("x", [variable("N")]));
  assert(results.length === 1, "expected 1, got " + results.length);
});

test("retractall clears from DB", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.queryFirst(compound("assert", [compound("t", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("t", [num(2)])]));
  e1.queryFirst(compound("assert", [compound("t", [num(3)])]));
  e1.queryFirst(compound("retractall", [compound("t", [variable("_")])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var results = e2.query(compound("t", [variable("N")]));
  assert(results.length === 0, "expected 0, got " + results.length);
});

test("predicates filter", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db), { "keep/1": true });
  e1.queryFirst(compound("assert", [compound("keep", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("skip", [num(2)])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db), { "keep/1": true });
  var keep = e2.query(compound("keep", [variable("N")]));
  var skip = e2.query(compound("skip", [variable("N")]));
  assert(keep.length === 1, "expected 1 keep, got " + keep.length);
  assert(skip.length === 0, "expected 0 skip, got " + skip.length);
});

test("duplicate assert dedup", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.queryFirst(compound("assert", [compound("x", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("x", [num(1)])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var results = e2.query(compound("x", [variable("N")]));
  assert(results.length === 1, "expected 1 (deduped), got " + results.length);
});

test("retractall + assert update", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.queryFirst(compound("assert", [compound("temp", [atom("kitchen"), num(20)])]));
  e1.queryFirst(compound("retractall", [compound("temp", [atom("kitchen"), variable("_")])]));
  e1.queryFirst(compound("assert", [compound("temp", [atom("kitchen"), num(22)])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var results = e2.query(compound("temp", [atom("kitchen"), variable("T")]));
  assert(results.length === 1, "expected 1, got " + results.length);
  assert(results[0].args[1].value === 22, "expected 22");
});

test("addClause persists facts", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.addClause(compound("sensor", [atom("s1"), atom("online")]));
  e1.addClause(compound("sensor", [atom("s2"), atom("offline")]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var results = e2.query(compound("sensor", [variable("Id"), variable("Status")]));
  assert(results.length === 2, "expected 2, got " + results.length);
});

test("addClause skips rules", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.addClause(compound("x", [num(1)]));
  e1.addClause(compound("double", [variable("X"), variable("Y")]),
    [compound("is", [variable("Y"), compound("*", [variable("X"), num(2)])])]
  );

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  var facts = e2.query(compound("x", [variable("N")]));
  assert(facts.length === 1, "expected 1 fact, got " + facts.length);
  assert(e2.clauses.length === 1, "expected 1 clause, got " + e2.clauses.length);
});

test("per-predicate tables", function() {
  var db = new MockDB();
  var e = new PrologEngine();
  persist(e, qsqlAdapter(db));
  e.queryFirst(compound("assert", [compound("color", [atom("red")])]));
  e.queryFirst(compound("assert", [compound("price", [atom("aapl"), num(187)])]));

  assert(db._tables["q$color$1"] !== undefined, "missing q$color$1");
  assert(db._tables["q$price$2"] !== undefined, "missing q$price$2");
  assert(db._tables["qsql_meta"] !== undefined, "missing qsql_meta");
});

test("typed column storage", function() {
  var db = new MockDB();
  var e = new PrologEngine();
  persist(e, qsqlAdapter(db));
  e.queryFirst(compound("assert", [compound("price", [atom("aapl"), num(187)])]));

  var table = db._tables["q$price$2"];
  var keys = Object.keys(table.rows);
  assert(keys.length === 1, "expected 1 row");
  var row = table.rows[keys[0]];
  assert(row.arg0 === "aapl", "arg0 should be 'aapl', got: " + row.arg0);
  assert(row.arg1 === 187, "arg1 should be 187, got: " + row.arg1);
});

test("multiple predicates", function() {
  var db = new MockDB();
  var e1 = new PrologEngine();
  persist(e1, qsqlAdapter(db));
  e1.queryFirst(compound("assert", [compound("a", [num(1)])]));
  e1.queryFirst(compound("assert", [compound("b", [num(2), num(3)])]));
  e1.queryFirst(compound("assert", [compound("c", [num(4), num(5), num(6)])]));

  var e2 = new PrologEngine();
  persist(e2, qsqlAdapter(db));
  assert(e2.query(compound("a", [variable("X")])).length === 1);
  assert(e2.query(compound("b", [variable("X"), variable("Y")])).length === 1);
  assert(e2.query(compound("c", [variable("X"), variable("Y"), variable("Z")])).length === 1);
});

console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
