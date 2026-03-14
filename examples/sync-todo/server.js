// ============================================================
// server.js — Synchronized todo server (Bun + Node.js)
//
// Run:  bun run examples/sync-todo/server.js
//       node examples/sync-todo/server.js
//
// No npm dependencies required for either runtime.
//
// The server is the single source of truth. Clients send
// assert/retract requests; the server validates, applies,
// and broadcasts to all connected clients.
// ============================================================

import { PrologEngine } from "../../src/prolog-engine.js";
import { serialize, deserialize, SyncEngine } from "../../src/sync.js";
import { persist } from "../../src/persist.js";
import { buildTodoKB } from "./todo-kb.js";
import { fileURLToPath } from "url";
import { dirname, join, extname } from "path";

// ── Runtime detection ───────────────────────────────────────

const IS_BUN = typeof Bun !== "undefined";

// ── File path resolution ────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Route table ─────────────────────────────────────────────

const ROUTES = {
  "/":                      join(__dir, "client.html"),
  "/todo-kb.js":            join(__dir, "todo-kb.js"),
  "/src/prolog-engine.js":  join(__dir, "../../src/prolog-engine.js"),
  "/src/sync.js":           join(__dir, "../../src/sync.js"),
};

// ── MIME types for static serving ───────────────────────────

const MIME = { ".html": "text/html", ".js": "application/javascript" };

// ── Build the authoritative engine ──────────────────────────

const engine = buildTodoKB(PrologEngine);
const { atom, compound } = PrologEngine;

// ── Attach SQLite persistence (optional — works without it) ─

let _db = null;
try {
  if (IS_BUN) {
    const { Database } = await import("bun:sqlite");
    _db = new Database(join(__dir, "todos.db"));
  }
} catch(e) {}

if (_db) {
  persist(engine, _db, { "todo/4": true });
  console.log("Persistence: SQLite (todos.db)");
} else {
  console.log("Persistence: none (in-memory only)");
}

const clients = new Set();

const sync = new SyncEngine(engine, {
  onSync() {
    const count = engine.queryFirst(compound("todo_count", [PrologEngine.variable("A"), PrologEngine.variable("D")]));
    if (count) {
      console.log(`  [${sync._facts.length} facts] active: ${count.args[0].value}, done: ${count.args[1].value}`);
    }
  }
});

// Bridge: populate SyncEngine._facts with any facts restored from DB
for (const c of engine.clauses) {
  if (c.body.length === 0 && c.head.type === "compound" && c.head.functor === "todo") {
    sync._facts.push(c.head);
  }
}

// Seed starter todos only if DB was empty
if (sync._facts.length === 0) {
  sync.assertFact(compound("todo", [atom("seed-1"), atom("Try adding a todo"), atom("active"), atom("Server")]));
  sync.assertFact(compound("todo", [atom("seed-2"), atom("Open a second browser tab"), atom("active"), atom("Server")]));
}

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

// ── Handle incoming WebSocket message ───────────────────────

function handleMessage(ws, raw) {
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
}

// ── Handle new WebSocket connection ─────────────────────────

function handleOpen(ws) {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: "snapshot", facts: sync.getSnapshot() }));
  console.log(`Client connected (${clients.size} total)`);
}

// ── Handle WebSocket close ──────────────────────────────────

function handleClose(ws) {
  clients.delete(ws);
  console.log(`Client disconnected (${clients.size} total)`);
}

// ════════════════════════════════════════════════════════════
// Bun server
// ════════════════════════════════════════════════════════════

if (IS_BUN) {
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
        handleOpen(ws);
      },

      message(ws, raw) {
        handleMessage(ws, raw);
      },

      close(ws) {
        handleClose(ws);
      }
    }
  });

  console.log("Todo server running at http://localhost:3001 (Bun)");
}

// ════════════════════════════════════════════════════════════
// Node.js server (built-in http + manual WebSocket RFC 6455)
// ════════════════════════════════════════════════════════════

if (!IS_BUN) {
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");

  // ── Minimal WebSocket frame helpers (RFC 6455) ────────────

  const WS_MAGIC = "258EAFA5-E914-47DA-95CA-5AB5FD35E3E5";

  function computeAcceptKey(key) {
    return createHash("sha1").update(key + WS_MAGIC).digest("base64");
  }

  // Encode a text frame (server → client, unmasked)
  function encodeTextFrame(text) {
    const payload = Buffer.from(text, "utf8");
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      // 64-bit length (not needed for this demo, but included for correctness)
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
  }

  // Encode a close frame (server → client, unmasked)
  function encodeCloseFrame(code) {
    const header = Buffer.alloc(4);
    header[0] = 0x88; // FIN + close opcode
    header[1] = 2;    // payload length = 2 (status code)
    header.writeUInt16BE(code || 1000, 2);
    return header;
  }

  // Encode a pong frame (server → client, unmasked)
  function encodePongFrame(payload) {
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x8A; // FIN + pong opcode
      header[1] = len;
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x8A;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    }

    return Buffer.concat([header, payload]);
  }

  // ── Node WebSocket wrapper ────────────────────────────────

  class NodeWebSocket {
    constructor(socket) {
      this.socket = socket;
      this.readyState = 1; // OPEN
      this._buffer = Buffer.alloc(0);
      this.onmessage = null;
      this.onclose = null;

      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => this._onSocketClose());
      socket.on("error", () => this._onSocketClose());
    }

    send(data) {
      if (this.readyState !== 1) return;
      try {
        this.socket.write(encodeTextFrame(String(data)));
      } catch (e) {
        // socket may have been destroyed
      }
    }

    close(code) {
      if (this.readyState !== 1) return;
      this.readyState = 2; // CLOSING
      try {
        this.socket.write(encodeCloseFrame(code || 1000));
      } catch (e) {
        // ignore
      }
      this.socket.end();
      this.readyState = 3; // CLOSED
    }

    _onSocketClose() {
      if (this.readyState < 3) {
        this.readyState = 3;
        if (this.onclose) this.onclose();
      }
    }

    _onData(chunk) {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._parseFrames();
    }

    _parseFrames() {
      while (this._buffer.length >= 2) {
        const byte0 = this._buffer[0];
        const byte1 = this._buffer[1];
        const opcode = byte0 & 0x0F;
        const masked = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7F;
        let offset = 2;

        if (payloadLen === 126) {
          if (this._buffer.length < 4) return; // need more data
          payloadLen = this._buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (this._buffer.length < 10) return; // need more data
          // Read as two 32-bit values (avoid BigInt for compat)
          const high = this._buffer.readUInt32BE(2);
          const low = this._buffer.readUInt32BE(6);
          payloadLen = high * 0x100000000 + low;
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        const totalLen = offset + maskLen + payloadLen;

        if (this._buffer.length < totalLen) return; // need more data

        let maskKey = null;
        if (masked) {
          maskKey = this._buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        let payload = this._buffer.subarray(offset, offset + payloadLen);

        if (masked && maskKey) {
          // Unmask in place on a copy
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i & 3];
          }
        }

        // Consume this frame from the buffer
        this._buffer = this._buffer.subarray(totalLen);

        // Handle by opcode
        if (opcode === 0x1) {
          // Text frame
          const text = payload.toString("utf8");
          if (this.onmessage) this.onmessage(text);
        } else if (opcode === 0x8) {
          // Close frame — echo back and close
          try {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
            this.socket.write(encodeCloseFrame(code));
          } catch (e) {
            // ignore
          }
          this.socket.end();
          this.readyState = 3;
          if (this.onclose) this.onclose();
          return;
        } else if (opcode === 0x9) {
          // Ping — respond with pong
          try {
            this.socket.write(encodePongFrame(payload));
          } catch (e) {
            // ignore
          }
        }
        // opcode 0xA (pong) — ignore
      }
    }
  }

  // ── HTTP + WebSocket server ───────────────────────────────

  const server = createServer((req, res) => {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    const file = ROUTES[path];

    if (file) {
      try {
        const content = readFileSync(file);
        const ext = extname(file);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(content);
      } catch (e) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);

    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n");

    socket.write(responseHeaders);

    const ws = new NodeWebSocket(socket);

    ws.onmessage = (text) => handleMessage(ws, text);
    ws.onclose = () => handleClose(ws);

    handleOpen(ws);
  });

  server.listen(3001, () => {
    console.log("Todo server running at http://localhost:3001 (Node.js)");
  });
}
