import { createElement, lazy, Suspense, useSyncExternalStore } from "react";
import htm from "htm";
import { isOpen, subscribe } from "./state.js";

const html = htm.bind(createElement);

/**
 * The lazy boundary. `chat/context/gate.js` is the other instance; they stay separate
 * because `lazy()` needs a statically analysable `import()` specifier.
 *
 * THE EARLY `return null` IS THE MECHANISM, not a rendering nicety: `lazy()` fetches when
 * the component is first RENDERED, so while the inspector is closed `modal.js` and
 * everything it pulls in have never been requested.
 *
 * `fallback` is `null` rather than a spinner -- these are a few kB from the origin that
 * just served the deck, and a scrim that appears empty and then fills in looks broken.
 */
const ToolsModal = lazy(() => import("./modal.js"));

export const ToolsGate = () => {
  const open = useSyncExternalStore(subscribe, isOpen);
  if (!open) return null;

  return html`<${Suspense} fallback=${null}><${ToolsModal} /><//>`;
};
