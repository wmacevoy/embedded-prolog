#!/usr/bin/env python3
# ============================================================
# gateway/main.py — Greenhouse mesh gateway
#
# Bridges the UDP mesh network to an HTTP API.
# Uses Y@ Python engine with ephemeral/react
# signal policy.
#
# HTTP API (port 8080 by default):
#   GET /api/health     -> {"ok": true, "node": "gateway"}
#   GET /api/status     -> mesh status / alert summary
#   GET /api/alerts     -> all alert_notice facts
#   GET /api/estimates  -> all estimate facts
#
# Environment variables:
#   LISTEN_PORT  — UDP listen port (default 9500)
#   HTTP_PORT    — HTTP server port (default 8080)
# ============================================================

import json
import os
import socket
import threading
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Import the Prolog engine from src/ ────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for _candidate in [
    os.path.join(_SCRIPT_DIR, "src"),           # Docker: /app/src
    os.path.join(_SCRIPT_DIR, "..", "..", "..", "src"),  # local dev
]:
    _candidate = os.path.abspath(_candidate)
    if os.path.isdir(_candidate):
        sys.path.insert(0, _candidate)
        break

from prolog import Engine, atom, var, compound, num, term_to_str, deep_walk


# ── Configuration ─────────────────────────────────────────────

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "9500"))
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
UDP_BUF_SIZE = 4096


# ── Compact term serialization (JSON <-> Prolog terms) ────────

def serialize(term):
    if term[0] == "atom":
        return {"t": "a", "n": term[1]}
    if term[0] == "num":
        return {"t": "n", "v": term[1]}
    if term[0] == "compound":
        return {
            "t": "c",
            "f": term[1],
            "a": [serialize(a) for a in term[2]],
        }
    return None


def deserialize(obj):
    if not obj:
        return None
    t = obj.get("t")
    if t == "a":
        return ("atom", obj["n"])
    if t == "n":
        return ("num", obj["v"])
    if t == "c":
        return (
            "compound",
            obj["f"],
            tuple(deserialize(a) for a in obj["a"]),
        )
    return None


# ── Term -> plain-Python conversion (for JSON API responses) ──

def term_to_py(term):
    if term is None:
        return None
    if term[0] == "atom":
        return term[1]
    if term[0] == "num":
        return term[1]
    if term[0] == "var":
        return "_"
    if term[0] == "compound":
        return {
            "f": term[1],
            "a": [term_to_py(a) for a in term[2]],
        }
    return None


# ── Prolog engine setup ──────────────────────────────────────

def create_engine():
    """Create and configure the gateway's Prolog engine with
    ephemeral/react signal policy."""
    eng = Engine()

    # Register ephemeral/1 builtin (scoped assertion)
    def _ephemeral(goal, rest, subst, depth, on_sol):
        term = deep_walk(goal[2][0], subst)
        eng.clauses.append((term, []))
        try:
            eng._solve(rest, subst, depth + 1, on_sol)
        finally:
            eng.retract_first(term)
    eng.builtins["ephemeral/1"] = _ephemeral

    # Identity
    eng.add_clause(compound("node_role", [atom("gateway")]))
    eng.add_clause(compound("node_id", [atom("gateway")]))

    # handle_signal(From, Fact) :- ephemeral(signal(From, Fact)), react.
    eng.add_clause(
        compound("handle_signal", [var("From"), var("Fact")]),
        [
            compound("ephemeral", [compound("signal", [var("From"), var("Fact")])]),
            ("atom", "react"),
        ]
    )

    # react :- signal(coordinator, estimate(Type, Node, Val, Confidence, Ts)),
    #          node_role(gateway),
    #          retractall(estimate(Type, Node, A, B, C)),
    #          assert(estimate(Type, Node, Val, Confidence, Ts)).
    eng.add_clause(
        ("atom", "react"),
        [
            compound("signal", [
                atom("coordinator"),
                compound("estimate", [var("Type"), var("Node"), var("Val"), var("Confidence"), var("Ts")])
            ]),
            compound("node_role", [atom("gateway")]),
            compound("retractall", [
                compound("estimate", [var("Type"), var("Node"), var("A"), var("B"), var("C")])
            ]),
            compound("assert", [
                compound("estimate", [var("Type"), var("Node"), var("Val"), var("Confidence"), var("Ts")])
            ]),
        ]
    )

    # react :- signal(coordinator, alert_notice(Node, Type, Level)),
    #          node_role(gateway),
    #          retractall(alert_notice(Node, Type, A)),
    #          assert(alert_notice(Node, Type, Level)).
    eng.add_clause(
        ("atom", "react"),
        [
            compound("signal", [
                atom("coordinator"),
                compound("alert_notice", [var("Node"), var("Type"), var("Level")])
            ]),
            compound("node_role", [atom("gateway")]),
            compound("retractall", [
                compound("alert_notice", [var("Node"), var("Type"), var("A")])
            ]),
            compound("assert", [
                compound("alert_notice", [var("Node"), var("Type"), var("Level")])
            ]),
        ]
    )

    return eng


# ── UDP listener ──────────────────────────────────────────────

def _send_udp(sock, target_host, target_port, from_id, fact_term):
    """Send a serialized signal over UDP."""
    payload = json.dumps({
        "kind": "signal",
        "from": from_id,
        "fact": serialize(fact_term),
    }).encode("utf-8")
    try:
        sock.sendto(payload, (target_host, target_port))
        print(f"[gateway] sent to {target_host}:{target_port}")
    except Exception as e:
        print(f"[gateway] send failed: {e}")


def _resolve_target(target_name):
    """Resolve a target name to (host, port) for UDP dispatch."""
    addr = os.environ.get(
        target_name.upper() + "_ADDR",
        target_name + ":9500",
    )
    if ":" in addr:
        host, port_str = addr.rsplit(":", 1)
        return host, int(port_str)
    return addr, 9500


def udp_listener(engine, lock):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", LISTEN_PORT))
    print(f"[gateway] UDP listening on port {LISTEN_PORT}")

    while True:
        try:
            data, addr = sock.recvfrom(UDP_BUF_SIZE)
            msg = json.loads(data.decode("utf-8"))

            if msg.get("kind") != "signal":
                continue

            sender = msg.get("from", "")
            fact_obj = msg.get("fact")
            fact_term = deserialize(fact_obj)

            with lock:
                goal = compound("handle_signal", [atom(sender), fact_term])
                result = engine.query_with_sends(goal)
                if result["result"]:
                    print(f"[gateway] accepted signal from {sender}")
                    # Dispatch sends from react rules over UDP
                    for s in result["sends"]:
                        target_name = s[0][1] if s[0][0] == "atom" else str(s[0])
                        host, port = _resolve_target(target_name)
                        _send_udp(sock, host, port, "gateway", s[1])
                else:
                    print(f"[gateway] dropped signal from {sender}")

        except json.JSONDecodeError:
            print(f"[gateway] Malformed JSON from {addr}")
        except Exception as e:
            print(f"[gateway] UDP error: {e}")


# ── HTTP API ──────────────────────────────────────────────────

def make_handler(engine, lock):
    class GatewayHandler(BaseHTTPRequestHandler):

        def _json_response(self, status, body):
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = self.path.split("?")[0]

            if path == "/api/health":
                self._handle_health()
            elif path == "/api/status":
                self._handle_status()
            elif path == "/api/alerts":
                self._handle_alerts()
            elif path == "/api/estimates":
                self._handle_estimates()
            else:
                self._json_response(404, {"error": "not found"})

        def _handle_health(self):
            self._json_response(200, {"ok": True, "node": "gateway"})

        def _handle_status(self):
            with lock:
                alert_pattern = compound(
                    "alert_notice", [var("T"), var("N"), var("D")]
                )
                alert = engine.query_first(alert_pattern)

                est_pattern = compound(
                    "estimate", [var("T"), var("N"), var("V"), var("C"), var("TS")]
                )
                estimates = engine.query(est_pattern, limit=200)

            self._json_response(200, {
                "status": "alert" if alert is not None else "normal",
                "estimates_count": len(estimates),
                "has_alerts": alert is not None,
            })

        def _handle_alerts(self):
            with lock:
                pattern = compound(
                    "alert_notice", [var("T"), var("N"), var("D")]
                )
                results = engine.query(pattern, limit=200)

            alerts = []
            for r in results:
                alerts.append({
                    "type": term_to_py(r[2][0]),
                    "node": term_to_py(r[2][1]),
                    "details": term_to_py(r[2][2]),
                })

            self._json_response(200, {"alerts": alerts})

        def _handle_estimates(self):
            with lock:
                pattern = compound(
                    "estimate",
                    [var("T"), var("N"), var("V"), var("C"), var("TS")],
                )
                results = engine.query(pattern, limit=200)

            estimates = []
            for r in results:
                estimates.append({
                    "type": term_to_py(r[2][0]),
                    "node": term_to_py(r[2][1]),
                    "value": term_to_py(r[2][2]),
                    "confidence": term_to_py(r[2][3]),
                    "timestamp": term_to_py(r[2][4]),
                })

            self._json_response(200, {"estimates": estimates})

        def log_message(self, format, *args):
            pass

    return GatewayHandler


# ── Main ──────────────────────────────────────────────────────

def main():
    engine = create_engine()
    lock = threading.Lock()

    udp_thread = threading.Thread(
        target=udp_listener, args=(engine, lock), daemon=True
    )
    udp_thread.start()

    handler_class = make_handler(engine, lock)
    server = HTTPServer(("0.0.0.0", HTTP_PORT), handler_class)
    print(f"[gateway] HTTP server on port {HTTP_PORT}")
    print(f"[gateway] Endpoints: /api/health, /api/status, /api/alerts, /api/estimates")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[gateway] Shutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
