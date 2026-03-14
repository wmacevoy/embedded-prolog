# Secure Sync-Todo

Same todo app, two additions:

1. **Server:** SQLCipher encrypted persistence
2. **Client:** WASM SQLite local persistence (offline-first)

## Server

```javascript
// One-line change: sqliteAdapter → sqlcipherAdapter
import { sqlcipherAdapter } from "../../src/persist-sqlcipher.js";

persist(engine, sqlcipherAdapter(db, process.env.TODO_SECRET));
// → todos encrypted at rest with AES-256
```

## Client (browser)

```html
<!-- Load WASM SQLite -->
<script src="/wasm/sqlite3.js"></script>
<script src="/wasm/shim.js"></script>
<script src="/src/persist-wasm.js"></script>

<script type="module">
  // 1. Open local WASM database
  var db = await createWasmDb("sqlite3.wasm");

  // 2. Build engine + rules (same as before)
  var engine = new PrologEngine();
  buildTodoKB(engine);

  // 3. Persist locally — todos survive tab close
  persist(engine, qsqlAdapter(db));

  // 4. Sync with server (unchanged)
  var sync = new SyncEngine(engine, { onSync: bump });
  ws.onmessage = handleMessage;  // snapshot/assert/retract
</script>
```

## What changes

| Feature | Before | After |
|---------|--------|-------|
| Server storage | SQLite (plaintext) | SQLCipher (AES-256) |
| Client storage | Memory only | WASM SQLite (persistent) |
| Tab close | Todos lost | Todos survive |
| Server down | Client empty | Client has local copy |
| Reconnect | Full snapshot reload | Reconcile from local |
| Encryption | None | Server: at rest. Client: when SQLCipher WASM is built |

## What doesn't change

- The Prolog rules (todo-kb.js)
- The sync protocol (WebSocket snapshot/assert/retract)
- The UI (Solid.js reactive rendering)
- The SyncEngine (fact tracking + deduplication)

The security and offline capability are infrastructure.
The application logic is unchanged.

## Offline-first flow

```
1. Client opens → load local DB → render from local facts
2. Connect to server → receive snapshot → reconcile
3. User adds todo → persist locally + send to server
4. Server broadcasts → other clients receive
5. Connection drops → client keeps working from local DB
6. Reconnect → server snapshot overwrites local (server wins)
```

## Build the WASM SQLite

```bash
docker compose run --rm wasm-build
# → wasm/dist/sqlite3.js + sqlite3.wasm
```

Copy `wasm/dist/*` to the server's static files directory.
The server already serves static files from the project root.
