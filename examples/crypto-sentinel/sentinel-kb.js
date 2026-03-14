// ============================================================
// sentinel-kb.js — Crypto Sentinel: encrypted shared price memory
//
// QJSON BigDecimal (M) for exact prices, BigInt (N) for timestamps.
// Prolog rules detect threshold crossings and fire trade alerts.
// Encrypted at rest via SQLCipher/qsql.
//
// Usage:
//   import { buildSentinelKB } from "./sentinel-kb.js";
//   var engine = buildSentinelKB(new PrologEngine(), loadString);
// ============================================================

function buildSentinelKB(engine, loadString) {
  loadString(engine,
    // ── Price thresholds (robot triggers) ─────────────────
    "threshold(btc, above, 70000M, sell_alert).\n" +
    "threshold(btc, below, 60000M, buy_alert).\n" +
    "threshold(eth, above, 4000M, sell_alert).\n" +
    "threshold(eth, below, 3000M, buy_alert).\n" +
    "threshold(sol, above, 200M, sell_alert).\n" +
    "threshold(sol, below, 100M, buy_alert).\n" +

    // ── Trigger detection ─────────────────────────────────
    // Fires when current price crosses a threshold
    "check_triggers(Symbol, Action, Price, Level) :- " +
    "  price(Symbol, Price, _Ts1), " +
    "  threshold(Symbol, above, Level, Action), " +
    "  Price > Level.\n" +

    "check_triggers(Symbol, Action, Price, Level) :- " +
    "  price(Symbol, Price, _Ts2), " +
    "  threshold(Symbol, below, Level, Action), " +
    "  Price < Level.\n" +

    // ── Signal processing (ephemeral/react) ───────────────
    // Incoming price update: retract old, assert new
    // Note: each anonymous var must have a unique name —
    // bare _ shares identity within a clause after freshening.
    "react :- " +
    "  signal(_Src, price_update(Symbol, Price, Ts)), " +
    "  retractall(price(Symbol, _OldP, _OldTs)), " +
    "  assert(price(Symbol, Price, Ts)).\n" +

    "handle_signal(From, Fact) :- " +
    "  ephemeral(signal(From, Fact)), " +
    "  react.\n" +

    // ── Portfolio valuation ───────────────────────────────
    "position_value(Symbol, Value) :- " +
    "  holding(Symbol, Amount), " +
    "  price(Symbol, Price, _Ts3), " +
    "  Value is Amount * Price.\n" +

    // ── Trusted feeds ─────────────────────────────────────
    "trusted_feed(coinbase).\n" +
    "trusted_feed(kraken).\n" +

    // ── Authenticated signal: only accept from trusted feeds
    "handle_trusted_signal(From, Fact) :- " +
    "  trusted_feed(From), " +
    "  handle_signal(From, Fact).\n" +

    "handle_trusted_signal(From, _Ignored) :- " +
    "  \\+ trusted_feed(From), " +
    "  assert(rejected(From)).\n"
  );

  return engine;
}

// ── Export (dual ESM/CJS) ───────────────────────────────────

if (typeof exports !== "undefined") {
  exports.buildSentinelKB = buildSentinelKB;
}
export { buildSentinelKB };
