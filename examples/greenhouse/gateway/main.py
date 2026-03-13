#!/usr/bin/env python3
# ============================================================
# gateway/main.py — Greenhouse mesh gateway
#
# Bridges the UDP mesh network to an HTTP API.
# Uses the embedded-prolog Python engine to store and query
# facts received from mesh nodes.
#
# Signal policy (enforced procedurally):
#   - estimate/5 accepted only from "estimator"
#   - alert_notice/3 accepted only from "coordinator"
#   - Everything else is silently ignored
#
# HTTP API (port 8080 by default):
#   GET /api/health     → {"ok": true, "node": "gateway"}
#   GET /api/status     → mesh status / alert summary
#   GET /api/alerts     → all alert_notice facts
#   GET /api/estimates  → all estimate facts
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
# In Docker: main.py at /app/, prolog.py at /app/src/
# Locally:   main.py at examples/greenhouse/gateway/, prolog.py at src/
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for _candidate in [
    os.path.join(_SCRIPT_DIR, "src"),           # Docker: /app/src
    os.path.join(_SCRIPT_DIR, "..", "..", "..", "src"),  # local dev
]:
    _candidate = os.path.abspath(_candidate)
    if os.path.isdir(_candidate):
        sys.path.insert(0, _candidate)
        break

from prolog import Engine, atom, var, compound, num, term_to_str


# ── Configuration ─────────────────────────────────────────────

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "9500"))
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
UDP_BUF_SIZE = 4096


# ── Compact term serialization (JSON ↔ Prolog terms) ─────────

def serialize(term):
    """Convert a Prolog term tuple to a compact JSON-serializable dict."""
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
    """Convert a compact JSON dict back to a Prolog term tuple."""
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


# ── Term → plain-Python conversion (for JSON API responses) ──

def term_to_py(term):
    """Convert a Prolog term into a plain Python value for JSON output."""
    if term is None:
        return None
    if term[0] == "atom":
        return term[1]
    if term[0] == "num":
        return term[1]
    if term[0] == "var":
        return "_"
    if term[0] == "compound":
        # Represent compounds as {"f": functor, "a": [args...]}
        return {
            "f": term[1],
            "a": [term_to_py(a) for a in term[2]],
        }
    return None


# ── Upsert helpers ────────────────────────────────────────────

def upsert_estimate(engine, term):
    """
    Upsert an estimate/5 fact.  Retract any previous estimate with the
    same (type, node) key before asserting the new one.

    estimate(Type, Node, Value, Confidence, Timestamp)
    """
    type_t = term[2][0]
    node_t = term[2][1]
    # Build a pattern that matches any estimate with the same type+node
    pattern = compound("estimate", [type_t, node_t, var("V"), var("C"), var("T")])
    engine.retract_first(pattern)
    engine.add_clause(term)


def upsert_alert_notice(engine, term):
    """
    Upsert an alert_notice/3 fact.  Retract any previous alert_notice
    with the same (type, node) key before asserting the new one.

    alert_notice(Type, Node, Details)
    """
    type_t = term[2][0]
    node_t = term[2][1]
    pattern = compound("alert_notice", [type_t, node_t, var("D")])
    engine.retract_first(pattern)
    engine.add_clause(term)


# ── Signal policy ─────────────────────────────────────────────

def handle_signal(engine, sender, fact_term):
    """
    Apply the gateway's signal policy:
      - estimate/5 accepted from "estimator" only
      - alert_notice/3 accepted from "coordinator" only
      - Everything else is ignored
    """
    if fact_term is None or fact_term[0] != "compound":
        return

    functor = fact_term[1]
    arity = len(fact_term[2])

    if functor == "estimate" and arity == 5 and sender == "estimator":
        upsert_estimate(engine, fact_term)
    elif functor == "alert_notice" and arity == 3 and sender == "coordinator":
        upsert_alert_notice(engine, fact_term)
    # else: silently ignored


# ── UDP listener ──────────────────────────────────────────────

def udp_listener(engine, lock):
    """
    Listen for JSON-encoded signals on UDP and update the Prolog
    engine's fact store accordingly.

    Expected wire format:
    {
        "kind": "signal",
        "from": "sensor_1",
        "fact": { "t": "c", "f": "reading", "a": [...] }
    }
    """
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
                handle_signal(engine, sender, fact_term)

        except json.JSONDecodeError:
            print(f"[gateway] Malformed JSON from {addr}")
        except Exception as e:
            print(f"[gateway] UDP error: {e}")


# ── HTTP API ──────────────────────────────────────────────────

def make_handler(engine, lock):
    """
    Factory that returns an HTTP request handler class bound to the
    shared Prolog engine and its lock.
    """

    class GatewayHandler(BaseHTTPRequestHandler):

        def _json_response(self, status, body):
            """Send a JSON response with the given status code and body dict."""
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        # ── GET dispatch ──────────────────────────────────────

        def do_GET(self):
            path = self.path.split("?")[0]  # strip query string

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

        # ── Endpoint handlers ─────────────────────────────────

        def _handle_health(self):
            self._json_response(200, {"ok": True, "node": "gateway"})

        def _handle_status(self):
            """
            Return a summary of the mesh status.  If any alert_notice
            facts exist, the mesh is in an "alert" state; otherwise
            it is "normal".
            """
            with lock:
                # Check for any alert_notice fact
                alert_pattern = compound(
                    "alert_notice", [var("T"), var("N"), var("D")]
                )
                alert = engine.query_first(alert_pattern)

                # Count estimates
                est_pattern = compound(
                    "estimate", [var("T"), var("N"), var("V"), var("C"), var("TS")]
                )
                estimates = engine.query(est_pattern, limit=200)

            if alert is not None:
                status = "alert"
            else:
                status = "normal"

            self._json_response(200, {
                "status": status,
                "estimates_count": len(estimates),
                "has_alerts": alert is not None,
            })

        def _handle_alerts(self):
            """Return all alert_notice/3 facts as a JSON list."""
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
            """Return all estimate/5 facts as a JSON list."""
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

        # Silence default logging on every request
        def log_message(self, format, *args):
            pass

    return GatewayHandler


# ── Main ──────────────────────────────────────────────────────

def main():
    # Shared Prolog engine and a threading lock to protect it
    engine = Engine()
    lock = threading.Lock()

    # Start UDP listener in a background daemon thread
    udp_thread = threading.Thread(
        target=udp_listener, args=(engine, lock), daemon=True
    )
    udp_thread.start()

    # Start the HTTP server on the main thread
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
