// ============================================================
// server.js — Crypto Sentinel HTTP server
//
// REST requests are ephemeral.  Routes are Prolog rules.
// Rules are fossilized.  No injection after startup.
//
// Run:
//   node examples/crypto-sentinel/server.js
//   bun  examples/crypto-sentinel/server.js
//
// Endpoints:
//   GET  /api/health           → { status: "ok", hash: "..." }
//   POST /api/price            → feed price, get alerts
//   GET  /api/price/:symbol    → current price
//   GET  /api/alerts           → all active alerts
//   GET  /api/alerts/:symbol   → alerts for one symbol
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { loadString } from "../../src/loader.js";
import { createReactiveEngine } from "../../src/reactive-prolog.js";
import { createHandler } from "../../src/serve.js";
import { fossilize, mineralize } from "../../src/fossilize.js";
import { buildSentinelKB } from "./sentinel-kb.js";
import { createHash } from "crypto";

// ── Build engine ────────────────────────────────────────────

var engine = new PrologEngine();

// Register ephemeral/1
var reactive = createReactiveEngine(engine);

// Load domain rules (thresholds, triggers, signal handling)
buildSentinelKB(engine, loadString);

// ── Route rules (Prolog) ────────────────────────────────────

loadString(engine,
  // Health check
  "handle(get, '/api/health', _Body1, response(200, ok)).\n" +

  // Reject untrusted feeds FIRST
  "handle(post, '/api/price', Body, response(403, rejected)) :- " +
  "  field(Body, feed, Feed), " +
  "  \\+ trusted_feed(Feed).\n" +

  // Feed price from trusted source
  "handle(post, '/api/price', Body, response(200, ok)) :- " +
  "  field(Body, feed, Feed), " +
  "  field(Body, symbol, Symbol), " +
  "  field(Body, price, Price), " +
  "  field(Body, timestamp, Ts), " +
  "  handle_trusted_signal(Feed, price_update(Symbol, Price, Ts)).\n" +

  // Get price by symbol: GET /api/price/:symbol
  "handle(get, Path, _Body2, response(200, obj([symbol-Symbol, price-Price, timestamp-Ts]))) :- " +
  "  path_segments(Path, [api, price, Symbol]), " +
  "  price(Symbol, Price, Ts).\n" +

  // Price not found
  "handle(get, Path, _Body3, response(404, not_found)) :- " +
  "  path_segments(Path, [api, price, _Sym]).\n" +

  // All alerts
  "handle(get, '/api/alerts', _Body4, response(200, Alerts)) :- " +
  "  findall(alert(S, A, P, L), check_triggers(S, A, P, L), Alerts).\n" +

  // Alerts by symbol: GET /api/alerts/:symbol
  "handle(get, Path, _Body5, response(200, Alerts)) :- " +
  "  path_segments(Path, [api, alerts, Symbol]), " +
  "  findall(alert(Symbol, A, P, L), check_triggers(Symbol, A, P, L), Alerts).\n"
);

// ── Lock it down ────────────────────────────────────────────

// Mineralize route handlers and domain rules
mineralize(engine, "handle", 4);
mineralize(engine, "threshold", 4);
mineralize(engine, "check_triggers", 4);
mineralize(engine, "react", 0);
mineralize(engine, "trusted_feed", 1);

// Fossilize: nothing changes after this
var boundary = fossilize(engine);

// ── Create handler ──────────────────────────────────────────

var handler = createHandler(engine, {
  onSends: function(sends, req) {
    for (var i = 0; i < sends.length; i++) {
      console.log("[audit] %s %s → %s", req.method, req.path,
        JSON.stringify({ target: sends[i].target, fact: sends[i].fact }));
    }
  }
});

// Compute fossil hash for audit
var hash = handler.fossilHash(function(text) {
  return createHash("sha256").update(text).digest("hex");
});

console.log("Fossil hash: " + hash);
console.log("Boundary: " + boundary + " clauses frozen");

// ── Serve ───────────────────────────────────────────────────

var PORT = parseInt(process.env.PORT || "4001", 10);

// Bun detection
var IS_BUN = typeof Bun !== "undefined";

if (IS_BUN) {
  Bun.serve({
    port: PORT,
    fetch: function(req) {
      var url = new URL(req.url);
      var method = req.method;
      var path = url.pathname;
      var body = null;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        body = req.text().then(function(text) {
          var res = handler.handleRequest(method, path, text);
          return new Response(res.body, {
            status: res.status, headers: res.headers
          });
        });
        return body;
      }
      var res = handler.handleRequest(method, path, null);
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
  });
  console.log("Listening on http://localhost:" + PORT + " (Bun)");
} else {
  var http = await import("http");
  http.createServer(function(req, res) {
    var chunks = [];
    req.on("data", function(c) { chunks.push(c); });
    req.on("end", function() {
      var body = chunks.length > 0 ? Buffer.concat(chunks).toString() : null;
      var result = handler.handleRequest(req.method, req.url, body);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
  }).listen(PORT, function() {
    console.log("Listening on http://localhost:" + PORT + " (Node)");
  });
}
