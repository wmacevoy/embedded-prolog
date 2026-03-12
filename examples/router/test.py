# ============================================================
# test.py — Message router tests, zero dependencies
#
# Run with:
#   python examples/router/test.py
#   micropython examples/router/test.py
# ============================================================

import sys, os
_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_dir, "..", "..", "src"))
sys.path.insert(0, _dir)

from prolog import Engine, atom, var, compound, num, lst, term_to_str, list_to_py
from reactive import signal, memo, effect
from reactive_prolog import ReactiveEngine
from router import build_router_kb, update_channel, update_battery

a, v, c, n = atom, var, compound, num

# ── Test harness ─────────────────────────────────────────────

_pass = [0]
_fail = [0]

def describe(name, fn):
    print("  " + name)
    fn()

def it(name, fn):
    try:
        fn()
        _pass[0] += 1
        print("    \u2713 " + name)
    except Exception as ex:
        _fail[0] += 1
        print("    \u2717 " + name)
        print("      " + str(ex))

def eq(got, want):
    if got != want:
        raise AssertionError("got %r, want %r" % (got, want))

def ok(val, msg=""):
    if not val:
        raise AssertionError(msg or ("not truthy: %r" % (val,)))

# ── Query helpers ────────────────────────────────────────────

def get_delivery(e, priority):
    """Returns (action, channel) for a message priority."""
    r = e.query_first(c("delivery", [a(priority), v("Act"), v("Ch")]))
    if r is None:
        return None
    return (r[2][1][1], r[2][2][1])

def get_all_routes(e, priority):
    """Returns list of channel names available for a priority."""
    r = e.query_first(c("all_routes", [a(priority), v("Rs")]))
    if r is None:
        return []
    return [t[1] for t in list_to_py(r[2][1])]

def get_battery_mode(e):
    r = e.query_first(c("battery_mode", [v("M")]))
    return r[2][0][1] if r else "?"

def get_display(e):
    r = e.query_first(c("display_status", [v("M")]))
    return r[2][0][1] if r else "?"

def get_active_channels(e):
    r = e.query_first(c("active_channels", [v("Chs")]))
    return [t[1] for t in list_to_py(r[2][0])] if r else []

# ════════════════════════════════════════════════════════════
# TESTS
# ════════════════════════════════════════════════════════════

print("\n  Prolog-Embedded \u2014 IoT Message Router\n")

describe("Normal operation", lambda: (
    it("starts with all channels up", lambda: (
        eq(get_active_channels(build_router_kb()),
           ["wifi", "cellular", "lora", "ble"]),
    )),
    it("battery mode is normal at 85%", lambda: (
        eq(get_battery_mode(build_router_kb()), "normal"),
    )),
    it("critical routes via wifi (most reliable)", lambda: (
        eq(get_delivery(build_router_kb(), "critical"), ("send", "wifi")),
    )),
    it("warning routes via wifi (best when battery normal)", lambda: (
        eq(get_delivery(build_router_kb(), "warning"), ("send", "wifi")),
    )),
    it("info routes via lora (cheapest)", lambda: (
        eq(get_delivery(build_router_kb(), "info"), ("send", "lora")),
    )),
    it("critical has 4 fallback channels", lambda: (
        eq(get_all_routes(build_router_kb(), "critical"),
           ["wifi", "cellular", "lora", "ble"]),
    )),
    it("display shows ALL SYSTEMS NOMINAL", lambda: (
        eq(get_display(build_router_kb()), "ALL SYSTEMS NOMINAL"),
    )),
))

describe("Channel failure \u2014 fallback", lambda: (
    it("wifi down \u2192 critical falls back to cellular", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        eq(get_delivery(e, "critical"), ("send", "cellular")),
    )),
    it("wifi + cellular down \u2192 critical falls back to lora", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        update_channel(e, "cellular", "down"),
        eq(get_delivery(e, "critical"), ("send", "lora")),
    )),
    it("three channels down \u2192 critical uses ble (last resort)", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        update_channel(e, "cellular", "down"),
        update_channel(e, "lora", "down"),
        eq(get_delivery(e, "critical"), ("send", "ble")),
    )),
    it("all channels down \u2192 no_route", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        update_channel(e, "cellular", "down"),
        update_channel(e, "lora", "down"),
        update_channel(e, "ble", "down"),
        eq(get_delivery(e, "critical"), ("no_route", "none")),
    )),
    it("all down \u2192 display shows NO ROUTE AVAILABLE", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        update_channel(e, "cellular", "down"),
        update_channel(e, "lora", "down"),
        update_channel(e, "ble", "down"),
        eq(get_display(e), "NO ROUTE AVAILABLE"),
    )),
    it("wifi down \u2192 warning falls back to lora", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        eq(get_delivery(e, "warning"), ("send", "lora")),
    )),
    it("channel recovery \u2192 route recalculates", lambda: (
        (e := build_router_kb()),
        update_channel(e, "wifi", "down"),
        eq(get_delivery(e, "critical")[1], "cellular"),
        update_channel(e, "wifi", "up"),
        eq(get_delivery(e, "critical")[1], "wifi"),
    )),
))

describe("Battery awareness", lambda: (
    it("battery 20% \u2192 mode is low", lambda: (
        (e := build_router_kb()),
        update_battery(e, 20),
        eq(get_battery_mode(e), "low"),
    )),
    it("battery low \u2192 warning prefers lora over wifi", lambda: (
        (e := build_router_kb()),
        update_battery(e, 20),
        eq(get_delivery(e, "warning"), ("send", "lora")),
    )),
    it("battery low \u2192 info still routes via lora", lambda: (
        (e := build_router_kb()),
        update_battery(e, 15),
        eq(get_delivery(e, "info"), ("send", "lora")),
    )),
    it("battery low \u2192 display shows BATTERY LOW", lambda: (
        (e := build_router_kb()),
        update_battery(e, 20),
        eq(get_display(e), "BATTERY LOW - POWER SAVING"),
    )),
    it("battery 5% \u2192 mode is critical", lambda: (
        (e := build_router_kb()),
        update_battery(e, 5),
        eq(get_battery_mode(e), "critical"),
    )),
    it("battery critical \u2192 info messages queued", lambda: (
        (e := build_router_kb()),
        update_battery(e, 5),
        eq(get_delivery(e, "info"), ("queue", "none")),
    )),
    it("battery critical \u2192 warning via lora (low power)", lambda: (
        (e := build_router_kb()),
        update_battery(e, 5),
        eq(get_delivery(e, "warning"), ("send", "lora")),
    )),
    it("battery critical \u2192 critical still routes via wifi", lambda: (
        (e := build_router_kb()),
        update_battery(e, 5),
        eq(get_delivery(e, "critical"), ("send", "wifi")),
    )),
    it("battery critical + lora down \u2192 warning via ble", lambda: (
        (e := build_router_kb()),
        update_battery(e, 5),
        update_channel(e, "lora", "down"),
        eq(get_delivery(e, "warning"), ("send", "ble")),
    )),
    it("battery critical + all low-power down \u2192 warning queued", lambda: (
        (e := build_router_kb()),
        update_battery(e, 5),
        update_channel(e, "lora", "down"),
        update_channel(e, "ble", "down"),
        eq(get_delivery(e, "warning"), ("queue", "none")),
    )),
))

describe("Reactive layer", lambda: (
    it("delivery recomputes on channel change", lambda: (
        (e := build_router_kb()),
        (rp := ReactiveEngine(e)),
        (route := rp.query_first(
            lambda: c("delivery", [a("critical"), v("Act"), v("Ch")]))),
        eq(route()[2][2][1], "wifi"),
        update_channel(e, "wifi", "down"),
        rp.bump(),
        eq(route()[2][2][1], "cellular"),
        update_channel(e, "wifi", "up"),
        rp.bump(),
        eq(route()[2][2][1], "wifi"),
    )),
    it("delivery recomputes on battery change", lambda: (
        (e := build_router_kb()),
        (rp := ReactiveEngine(e)),
        (route := rp.query_first(
            lambda: c("delivery", [a("info"), v("Act"), v("Ch")]))),
        eq(route()[2][1][1], "send"),
        update_battery(e, 5),
        rp.bump(),
        eq(route()[2][1][1], "queue"),
        update_battery(e, 50),
        rp.bump(),
        eq(route()[2][1][1], "send"),
    )),
    it("display recomputes on state change", lambda: (
        (e := build_router_kb()),
        (rp := ReactiveEngine(e)),
        (display := rp.query_first(
            lambda: c("display_status", [v("M")]))),
        eq(display()[2][0][1], "ALL SYSTEMS NOMINAL"),
        update_battery(e, 5),
        rp.bump(),
        eq(display()[2][0][1], "BATTERY CRITICAL"),
        update_battery(e, 50),
        rp.bump(),
        eq(display()[2][0][1], "ALL SYSTEMS NOMINAL"),
    )),
    it("full scenario: drain + failure + recovery", lambda: (
        (e := build_router_kb()),
        (rp := ReactiveEngine(e)),
        (crit_route := rp.query_first(
            lambda: c("delivery", [a("critical"), v("A"), v("C")]))),
        (info_route := rp.query_first(
            lambda: c("delivery", [a("info"), v("A2"), v("C2")]))),
        # Normal: critical via wifi, info via lora
        eq(crit_route()[2][2][1], "wifi"),
        eq(info_route()[2][2][1], "lora"),
        # Battery drains
        update_battery(e, 15),
        rp.bump(),
        eq(info_route()[2][2][1], "lora"),  # still lora
        # Battery critical
        update_battery(e, 5),
        rp.bump(),
        eq(info_route()[2][1][1], "queue"),  # info queued
        eq(crit_route()[2][2][1], "wifi"),   # critical still via wifi
        # WiFi fails
        update_channel(e, "wifi", "down"),
        rp.bump(),
        eq(crit_route()[2][2][1], "cellular"),  # critical falls back
        # Battery recovers
        update_battery(e, 80),
        rp.bump(),
        eq(info_route()[2][1][1], "send"),   # info sends again
        eq(info_route()[2][2][1], "lora"),   # via lora (wifi still down)
        # WiFi recovers
        update_channel(e, "wifi", "up"),
        rp.bump(),
        eq(crit_route()[2][2][1], "wifi"),   # critical back to wifi
    )),
))

# ── Summary ──────────────────────────────────────────────────

print("\n  %d passing, %d failing\n" % (_pass[0], _fail[0]))
if _fail[0] > 0:
    sys.exit(1)
