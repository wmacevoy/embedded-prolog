// ============================================================
// server.js — Synchronized todo server
//
// Run:  bun run examples/sync-todo/server.js
//       (Node: needs 'ws' package — npm i ws, then node --experimental-modules)
//
// The server is the single source of truth. Clients send
// assert/retract requests; the server validates, applies,
// and broadcasts to all connected clients.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, SyncEngine } from "../../src/sync.js";
import { buildTodoKB } from "./todo-kb.js";
import { join } from "path";

// ── Build the authoritative engine ──────────────────────────

const engine = buildTodoKB(PrologEngine);
const { atom, compound } = PrologEngine;

const clients = new Set();

const sync = new SyncEngine(engine, {
  onSync() {
    const count = engine.queryFirst(compound("todo_count", [PrologEngine.variable("A"), PrologEngine.variable("D")]));
    if (count) {
      console.log(`  [${sync._facts.length} facts] active: ${count.args[0].value}, done: ${count.args[1].value}`);
    }
  }
});

// Seed some starter todos
sync.assertFact(compound("todo", [atom("seed-1"), atom("Try adding a todo"), atom("active"), atom("Server")]));
sync.assertFact(compound("todo", [atom("seed-2"), atom("Open a second browser tab"), atom("active"), atom("Server")]));

// ── Validation ──────────────────────────────────────────────

function isValidFact(head) {
  return head &&
    head.type === "compound" &&
    head.functor === "todo" &&
    head.args.length === 4;
}

// ── Broadcast to all clients ────────────────────────────────

function broadcast(msg, exclude) {
  const json = typeof msg === "string" ? msg : JSON.stringify(msg);
  for (const ws of clients) {
    if (ws !== exclude && ws.readyState === 1) ws.send(json);
  }
}

// ── Static file serving ─────────────────────────────────────

const BASE = import.meta.dir;
const SRC = join(BASE, "../..");

const ROUTES = {
  "/":             join(BASE, "client.html"),
  "/todo-kb.js":   join(BASE, "todo-kb.js"),
  "/src/prolog-engine.js": join(SRC, "src/prolog-engine.js"),
  "/src/sync.js":  join(SRC, "src/sync.js"),
};

// ── Bun server ──────────────────────────────────────────────

Bun.serve({
  port: 3001,

  fetch(req, server) {
    if (server.upgrade(req)) return;

    const path = new URL(req.url).pathname;
    const file = ROUTES[path];
    if (file) return new Response(Bun.file(file));

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ kind: "snapshot", facts: sync.getSnapshot() }));
      console.log(`Client connected (${clients.size} total)`);
    },

    message(ws, raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch(e) { return; }

      if (msg.kind === "assert") {
        const head = deserialize(msg.head);
        if (isValidFact(head) && sync.assertFact(head)) {
          broadcast(msg);
        }
      } else if (msg.kind === "retract") {
        const head = deserialize(msg.head);
        if (isValidFact(head) && sync.retractFact(head)) {
          broadcast(msg);
        }
      }
    },

    close(ws) {
      clients.delete(ws);
      console.log(`Client disconnected (${clients.size} total)`);
    }
  }
});

console.log("Todo server running at http://localhost:3001");
