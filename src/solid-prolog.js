// ============================================================
// solid-prolog.js — SolidJS reactive bridge for PrologEngine
//
// Mirrors the reactive-prolog.js API exactly, but uses SolidJS
// primitives instead of the portable reactive.js runtime.
// ============================================================

import { createSignal, createMemo, createEffect } from "solid-js";

export function createSolidEngine(engineOrFactory) {
  const engine =
    typeof engineOrFactory === "function" ? engineOrFactory() : engineOrFactory;

  const [generation, setGeneration] = createSignal(0);

  const bump = () => setGeneration((g) => g + 1);

  const act = (goal) => {
    const result = engine.queryFirst(goal);
    bump();
    return result;
  };

  const _createQuery = (goalFn, limit) =>
    createMemo(() => {
      generation();
      return engine.query(goalFn(), limit || 50);
    });

  const _createQueryFirst = (goalFn) =>
    createMemo(() => {
      generation();
      return engine.queryFirst(goalFn());
    });

  const onUpdate = (fn) => {
    createEffect(() => {
      generation();
      fn();
    });
  };

  return {
    engine,
    generation,
    bump,
    act,
    createQuery: _createQuery,
    createQueryFirst: _createQueryFirst,
    onUpdate,
  };
}
