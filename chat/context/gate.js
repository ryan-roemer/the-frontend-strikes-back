import { createElement, lazy, Suspense, useSyncExternalStore } from "react";
import htm from "htm";
import { getShown, subscribe } from "./state.js";

const html = htm.bind(createElement);

/**
 * The lazy boundary, exactly as `chat/tools/gate.js` -- and for a stronger reason.
 *
 * The tools sheet is at least reachable from the deck chrome on every slide. This
 * one cannot be opened until somebody has loaded a model, asked a question, and got
 * an answer back, so on the overwhelming majority of loads it is code that would
 * never be run. `lazy()` fetches on first render, and the early `return null` below
 * is what makes sure that render only happens when the sheet is actually opened.
 */
const ContextModal = lazy(() => import("./modal.js"));

export const ContextGate = () => {
  const shown = useSyncExternalStore(subscribe, getShown);
  if (!shown) return null;

  return html`<${Suspense} fallback=${null}
    ><${ContextModal} context=${shown}
  /><//>`;
};
