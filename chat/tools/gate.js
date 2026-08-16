import { createElement, lazy, Suspense, useSyncExternalStore } from "react";
import htm from "htm";
import { isOpen, subscribe } from "./state.js";

const html = htm.bind(createElement);

/**
 * The lazy boundary, and the reason it is a separate file.
 *
 * `lazy()` does not fetch when it is declared -- it fetches when the component
 * it wraps is first RENDERED. So the early `return null` below is not a
 * rendering nicety, it is the entire lazy-loading mechanism: while the
 * inspector is closed, `modal.js` and everything it pulls in have never been
 * requested. The deck's initial load stays exactly what it was.
 *
 * `fallback` is `null` rather than a spinner. The modules are a few kB from the
 * same origin that just served the deck; a flash of "Loading..." would be on
 * screen for less time than it takes to read, and a scrim that appears empty and
 * then fills in looks broken in a way that an extra beat before it appears does
 * not.
 */
const ToolsModal = lazy(() => import("./modal.js"));

export const ToolsGate = () => {
  const open = useSyncExternalStore(subscribe, isOpen);
  if (!open) return null;

  return html`<${Suspense} fallback=${null}><${ToolsModal} /><//>`;
};
