import { createElement, lazy, Suspense, useSyncExternalStore } from "react";
import htm from "htm";
import { getShown, subscribe } from "./state.js";

const html = htm.bind(createElement);

/**
 * The lazy boundary, exactly as `chat/tools/gate.js` -- see there for how the
 * pattern works and why these are two files. The reason it applies here is
 * stronger: the tools sheet is at least reachable from the deck chrome on every
 * slide, whereas this one cannot be opened until somebody has loaded a model,
 * asked a question, and got an answer back. On the overwhelming majority of loads
 * it is code that would never be run.
 */
const ContextModal = lazy(() => import("./modal.js"));

export const ContextGate = () => {
  const shown = useSyncExternalStore(subscribe, getShown);
  if (!shown) return null;

  return html`<${Suspense} fallback=${null}
    ><${ContextModal} context=${shown}
  /><//>`;
};
