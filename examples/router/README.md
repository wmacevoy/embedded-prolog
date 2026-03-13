# IoT Message Router

Failover routing for an IoT device with 4 communication channels (WiFi,
Cellular, LoRa, BLE), battery-aware backoff, and priority-based delivery.

## What it demonstrates

- **Priority routing**: critical messages take different paths than info
- **Channel health**: routes around failed channels automatically
- **Battery awareness**: switches to low-power channels (LoRa, BLE) when
  battery drops below thresholds
- **Combinatorial state**: ~72 possible states handled with ~25 Prolog clauses
  instead of deeply nested if/else

## Files

| File | Language | Description |
|------|----------|-------------|
| `router.py` | Python | Knowledge base + helpers |
| `test.py` | Python | 28 tests |

## Run

```bash
python3 examples/router/test.py
micropython examples/router/test.py
```
