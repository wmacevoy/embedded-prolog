import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src"))
# ============================================================
# router.py — IoT message router as Prolog clauses
#
# An embedded device with 4 communication channels decides
# how to send telemetry and alerts based on:
#   - Message priority (critical / warning / info)
#   - Channel health (up / down)
#   - Battery level (0-100%)
#
# The Prolog engine handles the combinatorial explosion:
#   3 priorities x 3 battery modes x 4 channels x 2 statuses
#   = 72 possible states.  Prolog: ~25 clauses.  If/else: chaos.
#
# Usage:
#   from router import build_router_kb, update_channel, update_battery
#   e = build_router_kb()
#   # Query best route for a critical message:
#   e.query_first(compound("delivery", [atom("critical"), var("Action"), var("Ch")]))
# ============================================================

from prolog import Engine, atom, var, compound, num, lst, list_to_py


def build_router_kb():
    e = Engine()
    a, v, c, n = atom, var, compound, num

    # ── Channel definitions ───────────────────────────────
    # channel(Name, Bandwidth, PowerCost)
    #   wifi:     reliable, moderate power draw
    #   cellular: reliable, highest power draw
    #   lora:     low bandwidth, very low power, long range
    #   ble:      low bandwidth, very low power, short range
    for ch, bw, power in [
        ("wifi", "high", 3),
        ("cellular", "high", 4),
        ("lora", "low", 1),
        ("ble", "low", 1),
    ]:
        e.add_clause(c("channel", [a(ch), a(bw), n(power)]))

    # ── Initial state (dynamic facts) ─────────────────────
    # All channels up, battery at 85%
    for ch in ["wifi", "cellular", "lora", "ble"]:
        e.add_clause(c("channel_status", [a(ch), a("up")]))

    e.add_clause(c("battery_level", [n(85)]))

    # ── Channel availability ──────────────────────────────
    # channel_available(Ch) :- channel_status(Ch, up).
    e.add_clause(c("channel_available", [v("Ch")]),
        [c("channel_status", [v("Ch"), a("up")])])

    # active_channels(Chs) :- findall(Ch, channel_available(Ch), Chs).
    e.add_clause(c("active_channels", [v("Chs")]),
        [c("findall", [v("Ch"), c("channel_available", [v("Ch")]), v("Chs")])])

    # ── Battery mode ──────────────────────────────────────
    # Three modes derived from battery_level:
    #   critical (<10%) — shed non-essential traffic
    #   low (10-24%)    — prefer low-power channels
    #   normal (>=25%)  — full routing available

    e.add_clause(c("battery_mode", [a("critical")]),
        [c("battery_level", [v("B")]), c("<", [v("B"), n(10)])])

    e.add_clause(c("battery_mode", [a("low")]),
        [c("battery_level", [v("B")]),
         c(">=", [v("B"), n(10)]),
         c("<", [v("B"), n(25)])])

    e.add_clause(c("battery_mode", [a("normal")]),
        [c("battery_level", [v("B")]), c(">=", [v("B"), n(25)])])

    # ── Route selection ───────────────────────────────────
    # Clause order = preference.  query_first() returns the
    # first (best) match.  query() returns all fallbacks.
    #
    # Critical: reliability first.  Ignores battery mode —
    # a critical alert MUST get through.

    for ch in ["wifi", "cellular", "lora", "ble"]:
        e.add_clause(c("route", [a("critical"), a(ch)]),
            [c("channel_available", [a(ch)])])

    # Warning: adapts to battery.
    # Normal battery → wifi, lora, cellular
    for ch in ["wifi", "lora", "cellular"]:
        e.add_clause(c("route", [a("warning"), a(ch)]),
            [c("battery_mode", [a("normal")]),
             c("channel_available", [a(ch)])])

    # Low/critical battery → low-power only (lora, ble)
    for ch in ["lora", "ble"]:
        e.add_clause(c("route", [a("warning"), a(ch)]),
            [c("not", [c("battery_mode", [a("normal")])]),
             c("channel_available", [a(ch)])])

    # Info: cheapest first, shed when battery critical.
    # Normal battery → lora, ble, wifi
    for ch in ["lora", "ble", "wifi"]:
        e.add_clause(c("route", [a("info"), a(ch)]),
            [c("battery_mode", [a("normal")]),
             c("channel_available", [a(ch)])])

    # Low battery → lora, ble only
    for ch in ["lora", "ble"]:
        e.add_clause(c("route", [a("info"), a(ch)]),
            [c("battery_mode", [a("low")]),
             c("channel_available", [a(ch)])])

    # Critical battery → no info routes (queued instead)

    # ── Queue policy ──────────────────────────────────────
    # should_queue(info) :- battery_mode(critical).
    e.add_clause(c("should_queue", [a("info")]),
        [c("battery_mode", [a("critical")])])

    # should_queue(warning) :- battery_mode(critical),
    #                          \+ route(warning, _).
    e.add_clause(c("should_queue", [a("warning")]),
        [c("battery_mode", [a("critical")]),
         c("not", [c("route", [a("warning"), v("_QCh")])])])

    # ── Delivery decision ─────────────────────────────────
    # The top-level query: what to do with a message?
    #   delivery(Priority, Action, Channel)
    #   Action: send / queue / no_route

    # Send if not queued and a route exists
    e.add_clause(c("delivery", [v("P"), a("send"), v("Ch")]),
        [c("not", [c("should_queue", [v("P")])]),
         c("route", [v("P"), v("Ch")])])

    # Queue if queue policy says so
    e.add_clause(c("delivery", [v("P"), a("queue"), a("none")]),
        [c("should_queue", [v("P")])])

    # No route if not queued and no route exists
    e.add_clause(c("delivery", [v("P"), a("no_route"), a("none")]),
        [c("not", [c("should_queue", [v("P")])]),
         c("not", [c("route", [v("P"), v("_NRCh")])])])

    # ── All routes (for diagnostics) ──────────────────────
    # all_routes(Priority, Routes) :- findall(Ch, route(P,Ch), Routes).
    e.add_clause(c("all_routes", [v("P"), v("Rs")]),
        [c("findall", [v("Ch"), c("route", [v("P"), v("Ch")]), v("Rs")])])

    # ── Display status ────────────────────────────────────
    # Priority-ordered (first match wins via query_first)
    for msg, body in [
        ("NO ROUTE AVAILABLE",
            [c("not", [c("route", [a("critical"), v("_D1")])])]),
        ("BATTERY CRITICAL",
            [c("battery_mode", [a("critical")])]),
        ("BATTERY LOW - POWER SAVING",
            [c("battery_mode", [a("low")])]),
        ("ALL SYSTEMS NOMINAL",
            [c("battery_mode", [a("normal")])]),
    ]:
        e.add_clause(c("display_status", [a(msg)]), body)

    return e


# ── Helpers ───────────────────────────────────────────────

def update_channel(engine, channel, status):
    """Update a channel's status (up/down) in the Prolog database."""
    engine.retract_first(compound("channel_status", [atom(channel), var("_")]))
    engine.add_clause(compound("channel_status", [atom(channel), atom(status)]))


def update_battery(engine, level):
    """Update the battery level (0-100) in the Prolog database."""
    engine.retract_first(compound("battery_level", [var("_")]))
    engine.add_clause(compound("battery_level", [num(level)]))
