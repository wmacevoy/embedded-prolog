# Synchronized Todos

A collaborative todo list where Prolog facts sync over WebSocket between a
server and multiple browser clients. Both sides share the same rules; only
facts travel over the wire.

## What it demonstrates

- **Fact synchronization**: the transport layer carries `assert`/`retract`
  operations, not API responses — the "API" is just the fact schema
- **Shared rules, split facts**: `todo-kb.js` is imported by both server and
  client; derived queries (`todo_count`, `all_done`) work identically on both
  sides
- **Server as source of truth**: clients send requests; the server validates
  (only `todo/4` facts accepted), applies, and broadcasts to all clients
- **Snapshot on connect**: new clients receive the full fact state immediately
- **SolidJS reactive UI**: a generation signal bumps on every inbound fact
  change; memos re-query the local engine and the UI updates

## Architecture

```
todo-kb.js (shared rules)         <- imported by both
    |                   |
server.js            client.html
  PrologEngine         PrologEngine
  SyncEngine            SyncEngine
  |___ WebSocket ________|
       assert / retract / snapshot
```

## Files

| File | Description |
|------|-------------|
| `todo-kb.js` | Shared knowledge base — rules only, no state |
| `server.js` | Bun WebSocket server — validates, applies, broadcasts |
| `client.html` | SolidJS browser app — connects, syncs, renders |
| `test.js` | 26 tests — serialization, sync engine, KB rules, e2e |

## Run

Start the server:

```bash
bun run examples/sync-todo/server.js
```

Open `http://localhost:3001` in two or more browser tabs. Add, complete, and
delete todos — changes sync instantly across all tabs.

## Run tests

```bash
node examples/sync-todo/test.js
bun run examples/sync-todo/test.js
```

## Wire protocol

Messages are JSON objects with a `kind` field:

| Direction | kind | Payload |
|-----------|------|---------|
| Server -> Client | `snapshot` | `{ facts: [...] }` — full state on connect |
| Client -> Server | `assert` | `{ head: {...} }` — request to add a fact |
| Client -> Server | `retract` | `{ head: {...} }` — request to remove a fact |
| Server -> Client | `assert` | `{ head: {...} }` — broadcast applied assert |
| Server -> Client | `retract` | `{ head: {...} }` — broadcast applied retract |

Terms are serialized compactly: `atom("x")` becomes `{ t: "a", n: "x" }`,
`compound("f", [a])` becomes `{ t: "c", f: "f", a: [...] }`.
