// ============================================================
// test-qsql.js — Tests for qsql.js per-predicate typed adapter
//
// Run:  node src/test-qsql.js
// Uses MockDB — no better-sqlite3 or bun:sqlite needed.
// ============================================================

import { PrologEngine } from './prolog-engine.js';
import { persist } from './persist.js';
import { qsqlAdapter, _qsql_tableName, _qsql_argVal, _qsql_argInterval, _qsql_safeName, _nextUp, _nextDown, _sciToPlain, _decCmp, _roundingDir } from './qsql.js';

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
      var pkCols = [];
      var pkMatch = body.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
      if (pkMatch) {
        var pkParts = pkMatch[1].split(",");
        for (var p = 0; p < pkParts.length; p++) pkCols.push(pkParts[p].trim());
      }
      var colPart = body.replace(/,\s*PRIMARY KEY\s*\([^)]*\)/i, "");
      var rawCols = colPart.split(",");
      var cols = [];
      for (var i = 0; i < rawCols.length; i++) {
        var parts = rawCols[i].trim().split(/\s+/);
        var colName = parts[0];
        cols.push(colName);
        var hasInlinePK = false;
        for (var j = 0; j < parts.length; j++) {
          if (parts[j].toUpperCase() === "PRIMARY") { hasInlinePK = true; break; }
        }
        if (hasInlinePK) pkCols.push(colName);
      }
      var pkIndices = [];
      for (var i = 0; i < pkCols.length; i++) {
        for (var j = 0; j < cols.length; j++) {
          if (cols[j] === pkCols[i]) { pkIndices.push(j); break; }
        }
      }
      this._tables[tbl] = { cols: cols, pkIndices: pkIndices, rows: {} };
    }
  }
};

MockDB.prototype.prepare = function(sql) {
  var self = this;
  var im = sql.match(/INSERT OR IGNORE INTO\s+(?:"([^"]+)"|(\w+))/);
  if (im) {
    var tbl = im[1] || im[2];
    return {
      run: function() {
        var args = Array.prototype.slice.call(arguments);
        var table = self._tables[tbl];
        if (!table) return;
        var pk = "";
        for (var i = 0; i < table.pkIndices.length; i++) pk += String(args[table.pkIndices[i]]) + "\0";
        if (table.rows[pk]) return;
        var row = {};
        for (var i = 0; i < table.cols.length && i < args.length; i++) row[table.cols[i]] = args[i];
        table.rows[pk] = row;
      }
    };
  }
  var dm = sql.match(/DELETE FROM\s+(?:"([^"]+)"|(\w+))\s+WHERE\s+(\w+)\s*=\s*\?/);
  if (dm) {
    var tbl = dm[1] || dm[2];
    var col = dm[3];
    return {
      run: function(val) {
        var table = self._tables[tbl];
        if (!table) return;
        var toDelete = [];
        for (var pk in table.rows) { if (table.rows[pk][col] === val) toDelete.push(pk); }
        for (var i = 0; i < toDelete.length; i++) delete table.rows[toDelete[i]];
      }
    };
  }
  var sm = sql.match(/SELECT\s+(.+?)\s+FROM\s+(?:"([^"]+)"|(\w+))/);
  if (sm) {
    var colStr = sm[1];
    var tbl = sm[2] || sm[3];
    var selectCols = colStr.split(",");
    for (var i = 0; i < selectCols.length; i++) selectCols[i] = selectCols[i].trim();
    return {
      all: function() {
        var table = self._tables[tbl];
        if (!table) return [];
        var results = [];
        for (var pk in table.rows) {
          var row = table.rows[pk];
          var obj = {};
          for (var i = 0; i < selectCols.length; i++) obj[selectCols[i]] = row[selectCols[i]];
          results.push(obj);
        }
        return results;
      },
      run: function() {}
    };
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

// ── Interval tests ──────────────────────────────────────────

test("nextUp positive", function() {
  var x = 1.0;
  var u = _nextUp(x);
  assert(u > x, "nextUp(1.0) should be > 1.0");
  assert(u - x < 1e-15, "nextUp(1.0) should be within 1 ULP");
});

test("nextDown positive", function() {
  var x = 1.0;
  var d = _nextDown(x);
  assert(d < x, "nextDown(1.0) should be < 1.0");
  assert(x - d < 1e-15, "nextDown(1.0) should be within 1 ULP");
});

test("nextUp negative", function() {
  var u = _nextUp(-1.0);
  assert(u > -1.0, "nextUp(-1.0) should be > -1.0");
  assert(u < 0, "nextUp(-1.0) should still be negative");
});

test("nextDown negative", function() {
  var d = _nextDown(-1.0);
  assert(d < -1.0, "nextDown(-1.0) should be < -1.0");
});

test("nextUp zero", function() {
  assert(_nextUp(0) === 5e-324, "nextUp(0) should be Number.MIN_VALUE");
});

test("nextDown zero", function() {
  assert(_nextDown(0) === -5e-324, "nextDown(0) should be -Number.MIN_VALUE");
});

test("nextUp/nextDown are inverse", function() {
  var x = 42.5;
  assert(_nextDown(_nextUp(x)) === x, "nextDown(nextUp(x)) should be x");
  assert(_nextUp(_nextDown(x)) === x, "nextUp(nextDown(x)) should be x");
});

// ── Decimal comparison tests ─────────────────────────────────

test("decCmp equal", function() {
  assert(_decCmp("42", "42") === 0);
  assert(_decCmp("42.0", "42") === 0);
  assert(_decCmp("042", "42") === 0);
  assert(_decCmp("67432.50", "67432.5") === 0);
});

test("decCmp less/greater", function() {
  assert(_decCmp("41", "42") === -1);
  assert(_decCmp("43", "42") === 1);
  assert(_decCmp("0.1", "0.2") === -1);
  assert(_decCmp("0.100000000000000005551", "0.1") === 1, "double 0.1 > exact 0.1");
});

test("roundingDir exact doubles", function() {
  assert(_roundingDir(42, "42") === 0, "42 is exact");
  assert(_roundingDir(0.5, "0.5") === 0, "0.5 is exact");
  assert(_roundingDir(67432.5, "67432.50") === 0, "67432.50 is exact");
  assert(_roundingDir(1710000000, "1710000000") === 0, "1710000000 is exact");
});

test("roundingDir inexact doubles", function() {
  // 0.1 rounds UP in IEEE 754 (double > exact)
  assert(_roundingDir(0.1, "0.1") === 1, "0.1 rounds up");
  // 0.3 rounds DOWN (double < exact 0.3)
  assert(_roundingDir(0.3, "0.3") === -1, "0.3 rounds down");
});

test("sciToPlain", function() {
  assert(_sciToPlain("1.5e+3") === "1500", "1.5e+3");
  assert(_sciToPlain("1.23e-4") === "0.000123", "1.23e-4");
  assert(_sciToPlain("42") === "42", "plain passthrough");
  assert(_sciToPlain("1e+21") === "1000000000000000000000", "1e+21");
});

test("roundingDir extreme values (language-agnostic)", function() {
  // Overflow: Infinity > any finite value
  assert(_roundingDir(Infinity, "2e308") === 1, "Infinity > finite");
  assert(_roundingDir(-Infinity, "-2e308") === -1, "-Infinity < finite");
  // Underflow to zero: 0 < positive exact
  assert(_roundingDir(0, "5e-325") === -1, "0 < positive tiny");
  assert(_roundingDir(0, "-5e-325") === 1, "0 > negative tiny");
  assert(_roundingDir(0, "0") === 0, "0 == 0");
  // Very large (>= 1e21): toPrecision gives scientific notation, _sciToPlain handles it
  // 1e21 = 5^21 * 2^21, 5^21 < 2^53 → exactly representable
  assert(_roundingDir(1e21, "1000000000000000000000") === 0, "1e21 is exact");
  // 1e25 is NOT exact (5^25 > 2^53) → double rounds up
  assert(_roundingDir(1e25, "10000000000000000000000000") === 1, "1e25 rounds up");
  // Very small (< 1e-6): scientific notation in toPrecision
  // 2^-20 = 0.00000095367431640625 (exact, negative power of 2)
  assert(_roundingDir(Math.pow(2, -20), "0.00000095367431640625") === 0, "2^-20 is exact");
  // 1e-10 is NOT exact (no negative power of 10 is) → rounds up
  assert(_roundingDir(1e-10, "0.0000000001") === 1, "1e-10 rounds up");
});

// ── Interval tests (3-element: [val, lo, hi]) ───────────────

test("argInterval atom", function() {
  var iv = _qsql_argInterval({ t: "a", n: "btc" });
  assert(iv.length === 3, "3 elements");
  assert(iv[0] === "btc");
  assert(iv[1] === null && iv[2] === null);
});

test("argInterval plain number", function() {
  var iv = _qsql_argInterval({ t: "n", v: 42 });
  assert(iv.length === 3, "3 elements");
  assert(iv[0] === "42", "val is string");
  assert(iv[1] === 42 && iv[2] === 42, "point interval");
});

test("argInterval exact BigDecimal → point", function() {
  // 67432.50 is exactly representable as IEEE 754 double
  var iv = _qsql_argInterval({ t: "n", v: 67432.5, r: "67432.50M" });
  assert(iv[0] === "67432.50", "val = raw digits");
  assert(iv[1] === 67432.5, "lo = exact");
  assert(iv[2] === 67432.5, "hi = exact");
});

test("argInterval exact BigInt → point", function() {
  // 42 is exactly representable
  var iv = _qsql_argInterval({ t: "n", v: 42, r: "42N" });
  assert(iv[0] === "42", "val = raw digits");
  assert(iv[1] === 42, "lo = exact");
  assert(iv[2] === 42, "hi = exact");
});

test("argInterval inexact BigDecimal → 1-ULP bracket", function() {
  // 0.1 is NOT exact in IEEE 754 — double rounds UP
  var iv = _qsql_argInterval({ t: "n", v: 0.1, r: "0.1M" });
  assert(iv[0] === "0.1", "val = raw digits");
  assert(iv[1] < 0.1, "lo < double (nextDown)");
  assert(iv[2] === 0.1, "hi = double (since v > exact)");
  assert(iv[2] - iv[1] > 0, "interval has width");
});

test("argInterval brackets exact value", function() {
  // 0.3 rounds DOWN — double < exact 0.3
  var iv = _qsql_argInterval({ t: "n", v: 0.3, r: "0.3M" });
  assert(iv[0] === "0.3", "val = raw digits");
  assert(iv[1] === 0.3, "lo = double (since v < exact)");
  assert(iv[2] > 0.3, "hi > double (nextUp)");
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

// ── QSQL-specific: schema + intervals ───────────────────────

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
  assert(row.arg1 === "187", "arg1 should be '187' (string), got: " + row.arg1);
  // Plain number: lo == hi (point interval)
  assert(row.arg1_lo === 187, "arg1_lo should be 187");
  assert(row.arg1_hi === 187, "arg1_hi should be 187");
});

test("exact BigDecimal → point interval stored", function() {
  var db = new MockDB();
  var e = new PrologEngine();
  persist(e, qsqlAdapter(db));
  e.addClause(compound("price", [atom("btc"), num(67432.5, "67432.50M")]));

  var table = db._tables["q$price$2"];
  var keys = Object.keys(table.rows);
  var row = table.rows[keys[0]];
  assert(row.arg1 === "67432.50", "arg1 = value string");
  assert(row.arg1_lo === 67432.5, "arg1_lo = exact (point)");
  assert(row.arg1_hi === 67432.5, "arg1_hi = exact (point)");
});

test("exact BigInt → point interval stored", function() {
  var db = new MockDB();
  var e = new PrologEngine();
  persist(e, qsqlAdapter(db));
  e.addClause(compound("ts", [num(1710000000, "1710000000N")]));

  var table = db._tables["q$ts$1"];
  var keys = Object.keys(table.rows);
  var row = table.rows[keys[0]];
  assert(row.arg0 === "1710000000", "value string");
  assert(row.arg0_lo === 1710000000, "lo = exact (point)");
  assert(row.arg0_hi === 1710000000, "hi = exact (point)");
});

test("inexact BigDecimal → 1-ULP interval stored", function() {
  var db = new MockDB();
  var e = new PrologEngine();
  persist(e, qsqlAdapter(db));
  e.addClause(compound("rate", [num(0.1, "0.1M")]));

  var table = db._tables["q$rate$1"];
  var keys = Object.keys(table.rows);
  var row = table.rows[keys[0]];
  assert(row.arg0 === "0.1", "value string");
  assert(row.arg0_lo < row.arg0_hi, "lo < hi (non-point interval)");
  assert(row.arg0_lo <= 0.1 && row.arg0_hi >= 0.1, "interval brackets double");
});

test("atom has null interval", function() {
  var db = new MockDB();
  var e = new PrologEngine();
  persist(e, qsqlAdapter(db));
  e.addClause(compound("tag", [atom("btc")]));

  var table = db._tables["q$tag$1"];
  var keys = Object.keys(table.rows);
  var row = table.rows[keys[0]];
  assert(row.arg0 === "btc", "primary value");
  assert(row.arg0_lo === null || row.arg0_lo === undefined, "lo null for atom");
  assert(row.arg0_hi === null || row.arg0_hi === undefined, "hi null for atom");
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
