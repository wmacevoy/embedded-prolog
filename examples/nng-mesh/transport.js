// ============================================================
// transport.js — NNG transport abstraction + in-process simulation
//
// Defines the transport interface and provides SimBus, a pure-JS
// simulation of an NNG bus socket for testing without native deps.
//
// To plug in real NNG (via QuickJS C bindings):
//
//   class NngTransport {
//     constructor(url) {
//       this._sock = nng_bus0_open();
//       nng_listen(this._sock, url);
//     }
//     send(toAddress, payload) {
//       const wire = JSON.stringify({ to: toAddress, from: this._addr, payload });
//       nng_send(this._sock, wire, wire.length);
//     }
//     onReceive(cb) { /* nng_recv or nng_aio callback */ }
//     close() { nng_close(this._sock); }
//   }
//
// ============================================================

// ── SimBus: in-process message bus ──────────────────────────

export class SimBus {
  constructor() {
    this._nodes = new Map();     // address → receive callback
    this._log = [];              // message log for test inspection
  }

  /** Create a SimTransport bound to this bus at the given address. */
  createTransport(address) {
    return new SimTransport(this, address);
  }

  /** Register a node's receive handler. */
  _register(address, callback) {
    this._nodes.set(address, callback);
  }

  /** Remove a node from the bus. */
  _unregister(address) {
    this._nodes.delete(address);
  }

  /** Deliver a message. Payload is deep-copied to simulate wire. */
  _deliver(fromAddress, toAddress, payload) {
    const wireCopy = JSON.parse(JSON.stringify(payload));
    this._log.push({ from: fromAddress, to: toAddress, payload: wireCopy });

    const handler = this._nodes.get(toAddress);
    if (handler) handler(fromAddress, wireCopy);
    // If no handler registered, message is silently dropped (like real NNG)
  }

  /** Broadcast to all nodes except sender. */
  _broadcast(fromAddress, payload) {
    for (const [addr, handler] of this._nodes) {
      if (addr !== fromAddress) {
        const wireCopy = JSON.parse(JSON.stringify(payload));
        this._log.push({ from: fromAddress, to: addr, payload: wireCopy });
        handler(fromAddress, wireCopy);
      }
    }
  }
}

// ── SimTransport: per-node transport handle ─────────────────
//
// Implements the ITransport interface:
//   send(toAddress, payload)   — send to a specific node
//   broadcast(payload)         — send to all peers
//   onReceive(callback)        — register: function(fromAddress, payload)
//   close()                    — disconnect from bus

export class SimTransport {
  constructor(bus, address) {
    this._bus = bus;
    this.address = address;
    this._handler = null;
    bus._register(address, (from, payload) => {
      if (this._handler) this._handler(from, payload);
    });
  }

  send(toAddress, payload) {
    this._bus._deliver(this.address, toAddress, payload);
  }

  broadcast(payload) {
    this._bus._broadcast(this.address, payload);
  }

  onReceive(callback) {
    this._handler = callback;
  }

  close() {
    this._bus._unregister(this.address);
    this._handler = null;
  }
}
