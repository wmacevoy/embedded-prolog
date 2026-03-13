# NNG Sensor Mesh

IoT sensor mesh where multiple nodes communicate over a simulated NNG bus
transport.  Prolog policy rules (`on_signal/3`) control which signals get
accepted — signals never touch the database directly.

```
            SimBus (NNG bus simulation)
           ╱          │           ╲
    [sensor_1]    [sensor_2]   [coordinator]
     MeshNode      MeshNode     MeshNode
     Prolog        Prolog       Prolog
     Reactive      Reactive     Reactive
```

## What it demonstrates

- **Signal policy layer** — `send` is transport, `signal` is notification,
  `on_signal/3` Prolog rules decide assert / retract / ignore
- **Spoofing protection** — `on_signal(From, reading(From, ...))` uses
  Prolog unification to verify the sender matches the fact
- **Reactive aggregation** — alerts recompute automatically when facts land
- **Transport abstraction** — swap `SimBus` for real NNG C bindings
  (via QuickJS FFI) without changing any Prolog or application code

## Files

| File | Purpose |
|---|---|
| `mesh-kb.js` | Prolog rules: signal policy, alerts, aggregation |
| `transport.js` | SimBus/SimTransport (NNG simulation) |
| `node.js` | MeshNode: engine + reactive + sync + transport |
| `test.js` | 33 tests |

## Run

```bash
node examples/nng-mesh/test.js
bun run examples/nng-mesh/test.js
```

## Wire protocol

```json
{ "kind": "signal", "from": "sensor_1", "fact": { "t": "c", "f": "reading", "a": [...] } }
```

Facts use the compact serialization from `src/sync.js`.

## Plugging in real NNG

Replace `SimTransport` with a C-backed transport via QuickJS:

```c
// QuickJS C module
JSValue js_nng_send(JSContext *ctx, ...) {
    nng_send(sock, buf, len, 0);
}
```

The `MeshNode` constructor accepts any object with `send(addr, payload)`,
`broadcast(payload)`, `onReceive(cb)`, and `close()`.
