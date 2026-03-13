# Greenhouse Sensor Mesh

Multi-runtime IoT greenhouse monitor where four node types communicate
over UDP. Prolog policy rules (`on_signal/3`) on each node control which
signals get accepted — signals never touch the database directly.

```
            UDP mesh (one datagram = one signal)
           ╱          │           ╲           ╲
    [sensor_1]    [estimator]   [dashboard]   [gateway]
     C binary      Bun/JS       Bun/JS        Python
     prolog_core   PrologEngine PrologEngine  Engine
     readings      VPD calc     alerts+UI     REST API
```

## What it demonstrates

- **Four runtimes, one protocol** — C, JavaScript, Python nodes share
  the same compact wire format and signal policy architecture
- **Prolog signal policy** — `on_signal(From, Fact, Action)` rules decide
  assert / retract / ignore on every node
- **Spoofing protection** — `on_signal(From, reading(From, ...))` uses
  Prolog unification to verify the sender matches the fact
- **VPD estimation** — Magnus formula computes vapor pressure deficit from
  temperature + humidity (centikPa integers for Prolog comparison)
- **Reactive alerts** — coordinator Prolog rules detect threshold violations
  and flip mesh status
- **UDP bounded messages** — one datagram = one signal, no framing, works
  on ESP32's lwIP stack

## Node roles

| Node | Runtime | Role | Prolog engine |
|---|---|---|---|
| `sensor` | C (gcc) | Generates temp + humidity readings every 2s | `native/prolog_core.c` (terms only) |
| `estimator` | Bun/Node | Computes VPD from paired readings | `src/prolog-engine.js` |
| `dashboard` | Bun/Node | Coordinator: alerts, thresholds, web UI | `src/prolog-engine.js` + `src/loader.js` |
| `gateway` | Python | REST API bridge for external systems | `src/prolog.py` |

## Run (sim tests)

```bash
node examples/greenhouse/test.js
bun run examples/greenhouse/test.js
```

42 tests covering KB rules, signal policy for all 4 roles, VPD computation,
reactive alerts, and end-to-end scenarios.

## Run (Docker)

```bash
cd examples/greenhouse
docker compose up --build
```

- Dashboard: http://localhost:3000 (web UI + SSE)
- Gateway API: http://localhost:8080/api/health
- State: `curl http://localhost:3000/api/state`
- Trigger alert: `curl -X POST http://localhost:3000/api/threshold -H 'Content-Type: application/json' -d '{"type":"temperature","min":5,"max":18}'`

## Wire protocol

```json
{ "kind": "signal", "from": "sensor_1", "fact": { "t": "c", "f": "reading", "a": [...] } }
```

Facts use the compact serialization from `src/sync.js`:
atom `{"t":"a","n":"hello"}`, num `{"t":"n","v":42}`, compound `{"t":"c","f":"f","a":[...]}`.

## Files

| File | Purpose |
|---|---|
| `greenhouse-kb.js` | Shared Prolog rules: signal policy, alerts, aggregation |
| `node.js` | GreenhouseNode: engine + reactive + transport + VPD |
| `test.js` | 42 sim tests (SimBus, no Docker needed) |
| `sensor/main.c` | C sensor: prolog_core terms + UDP + simulated readings |
| `estimator/main.js` | Bun estimator: Magnus formula VPD, Prolog policy |
| `gateway/main.py` | Python gateway: Prolog engine + HTTP API |
| `dashboard/server.js` | Bun coordinator: Prolog + UDP + HTTP + SSE |
| `dashboard/index.html` | SolidJS-style reactive dashboard |
| `docker-compose.yml` | 5 services: dashboard, sensor, sensor2, estimator, gateway |

## Architecture

**Signal flow:**
```
sensor_1 ──reading──→ estimator ──estimate──→ dashboard (coordinator)
sensor_1 ──reading──→ dashboard                  │
sensor_2 ──reading──→ estimator                  │ alert_notice
sensor_2 ──reading──→ dashboard                  ↓
                                              gateway → HTTP API
dashboard ──threshold──→ sensors
```

**Each node's on_signal/3 policy:**

- **Coordinator**: accepts `reading/4` from online sensors (with spoofing
  protection), `estimate/5` from estimator, `node_status/2` from anyone
- **Estimator**: accepts `reading/4` from online sensors, `node_status/2`
- **Sensor**: accepts `calibration/3` and `threshold/3` from coordinator only
- **Gateway**: accepts `estimate/5` from estimator, `alert_notice/3` from coordinator
