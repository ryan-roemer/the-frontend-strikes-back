/* global document:false */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { ChatApp } from "./ui/app.js";
import { isEnabled } from "./state.js";
import { setSystemPrompt, warmUp } from "./agent/model-state.js";
import { systemPrompt } from "./agent/prompt.js";
import {
  start as startWatchdog,
  stop as stopWatchdog,
} from "./edit/watchdog.js";

const html = htm.bind(createElement);

const ROOT_ID = "chat-root";

/**
 * Mount the chat. The whole public surface of `chat/`, besides the two
 * components `Template` renders.
 *
 * A SECOND React root, on a div appended to `<body>` rather than anywhere inside
 * the deck. Three reasons, all learned from Spectacle's own layout:
 *
 *   1. Every slide is portaled into an aspect-fit box that carries a
 *      `transform: scale()` and `overflow: hidden`. A panel inside it would be
 *      scaled with the canvas and clipped at its edges.
 *   2. `TemplateWrapper` is `pointer-events: none`.
 *   3. Presenter and overview mode swap the entire View subtree, remounting
 *      everything inside it. A chat mounted there would lose its transcript to a
 *      stray `mod+shift+P`.
 *
 * Returns a teardown function -- unused by the deck, but it makes the module
 * testable from the console and documents that mounting is reversible.
 */
export const mountChat = () => {
  const root = document.documentElement;

  // Paged output has no viewport, no hover, and no business carrying a chat
  // window. `theme.js` sets `paged-mode` for both `?exportMode` and
  // `?printMode`, so this one check covers the PDF and the handout. A
  // `position: fixed` overlay already cost this deck a phantom page once.
  if (
    root.classList.contains("paged-mode") ||
    root.classList.contains("print-mode")
  ) {
    return () => {};
  }

  // Idempotent: a double mount would give the deck two panels and two sessions.
  if (document.getElementById(ROOT_ID)) return () => {};

  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.body.append(host);

  const reactRoot = createRoot(host);
  reactRoot.render(html`<${ChatApp} />`);

  // Deck knowledge is harvested from the live DOM, so the system prompt cannot be
  // built at import time -- it is handed over as a function and called when a
  // session is actually created.
  setSystemPrompt(systemPrompt);

  // Re-applies edits after a remount (presenter/overview mode). Cheap when idle:
  // one MutationObserver on the slide portal, childList only.
  startWatchdog();

  // Only when the panel is open on load, which now means only under `?chat` -- the
  // panel is closed by default and no longer remembers being open. So on a normal
  // deck load the model is not touched at all: no GPU probe, no Cache API lookup,
  // nothing. The panel runs its own check the first time it is opened.
  //
  // `warmUp()` stops at ON_DISK and never builds the engine, so even here this is a
  // probe rather than a load -- see the comment on `warmUp()` for why claiming ~2 GB
  // of GPU memory during page load is a bad trade.
  //
  // Not awaited: the deck is already interactive and must not wait on this.
  if (isEnabled()) warmUp();

  return () => {
    stopWatchdog();
    reactRoot.unmount();
    host.remove();
  };
};
