import { createElement } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { ChatApp } from "./ui/app.js";
import { isEnabled } from "./state.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  refresh,
  setSystemPrompt,
} from "./agent/model-state.js";
import { systemPrompt } from "./agent/prompt.js";
import { installDump } from "./harvest/dump.js";
import { installTools } from "./mcp/index.js";
import { installReplay } from "./replay/runner.js";

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
 * testable from the console and documents that mounting is reversible. It really
 * is: see the bottom of this function, where every one of the four installs
 * hands back the thing that undoes it.
 */
export const mountChat = () => {
  const root = document.documentElement;

  // Paged output has no viewport, no hover, and no business carrying a chat
  // window. TWO CLASSES, because `theme.js` sets them from two different
  // conditions -- `paged-mode` for the PDF export and `print-mode` for the
  // ink-saving handout -- and only one of them implies the other. A
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

  // The deck-as-Markdown harvest: `window.deckDump` in the console, `?dump` on
  // screen. Installed from here rather than from its own `import()` in
  // `index.html` so that removing the assistant stays THREE edits and they stay
  // together, exactly as the comment at that call site promises. It reads the
  // deck's React internals and shares nothing with the panel, so it is deliberate
  // that it goes up even when the model never does.
  const stopDump = installDump();

  // The deck as a WebMCP server: `document.modelContext` tools for reading,
  // navigating and editing the deck, all registered on a plain load. `?safe`
  // drops the editing ones. Installed beside the harvest because it is the same
  // seam -- it consumes `harvest/` and shares nothing with the panel -- and for
  // the same "three edits" reason.
  const stopTools = installTools();

  // The replay harness: `window.deckReplay` for a CDP client to drive a recorded fixture
  // against this deck. A NO-OP WITHOUT `?replay`, which is checked inside rather than here
  // so the flag lives next to the thing it gates -- the same shape as `?safe` in
  // `mcp/index.js`. Installed beside the other two for the same "three edits" reason, and
  // last because it is the only one that reads the other two.
  const stopReplay = installReplay();

  // A FUNCTION, NOT A STRING, and that is now load-bearing rather than merely a
  // seam left open: `systemPrompt()` reads a live harvest of the fiber tree for the
  // deck outline, so it cannot be evaluated until the deck has rendered. See the
  // header of `agent/prompt.js`.
  setSystemPrompt(systemPrompt);

  // Only when the panel is open on load, which now means only under `?chat` -- the
  // panel is closed by default and no longer remembers being open. So on a normal
  // deck load the model is not touched at all: no GPU probe, no Cache API lookup,
  // nothing. The panel runs its own check the first time it is opened.
  //
  // `refresh()` ASKS AND STOPS. It never builds the engine, which is a deliberate
  // reversal of what the Prompt API version did: there, warming up meant promoting
  // ON_DISK to READY so the first question streamed immediately. The same promotion
  // under LiteRT claims ~2 GB of GPU memory during page load, racing Spectacle's
  // 35-slide portal mount and react-spring's animations -- and Safari enforces
  // per-tab memory limits by KILLING THE TAB rather than throwing, so the worst case
  // is not a slow deck but no deck at all, before slide 1. The engine loads in ~1.2s
  // from a warm cache, so the first question pays almost nothing for this.
  //
  // Not awaited: the deck is already interactive and must not wait on this. Caught,
  // because nothing else is here to.
  if (isEnabled()) refresh().catch(() => {});

  // EVERYTHING THIS FUNCTION STARTED, IT STOPS. The four installs above each own
  // something outside React -- two `window` globals, a console handle, a mutation
  // observer -- and a teardown that unmounted the root while leaving those in place
  // was claiming a reversibility it did not have.
  return () => {
    reactRoot.unmount();
    host.remove();
    stopReplay();
    stopTools();
    stopDump();
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
  };
};
