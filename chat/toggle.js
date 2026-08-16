import { createElement, useSyncExternalStore } from "react";
import htm from "htm";
import { isEnabled, subscribe, toggleEnabled } from "./state.js";

const html = htm.bind(createElement);

/**
 * The sparkle, sitting next to Spectacle's fullscreen button in the deck chrome.
 *
 * Hooks are safe here for the same reason they are safe in `DeckBridge`: this is
 * rendered as an element, so it owns its own fiber. It must not become a plain
 * function call inside `Template`.
 *
 * `pointer-events` is the sharp edge. Spectacle's `TemplateWrapper` -- the box
 * the whole deck template renders into -- is `pointer-events: none`, and nothing
 * in `styles.css` re-enables it. Spectacle's own `FullScreen` works around this
 * by setting `pointerEvents: "all"` inline on itself; `.chat-toggle` does the
 * same in CSS. Drop that rule and the button renders perfectly and ignores every
 * click.
 *
 * Deliberately not using `Icon` from `deck/components.js`: that module imports
 * this one, and the cycle would be real. An `<i>` with the Phosphor classes is
 * what `Icon` renders anyway.
 */
export const ChatToggle = () => {
  const enabled = useSyncExternalStore(subscribe, isEnabled);

  return html`<button
    type="button"
    className=${`chat-toggle${enabled ? " chat-toggle--on" : ""}`}
    onClick=${toggleEnabled}
    aria-pressed=${enabled}
    title=${enabled ? "Close deck assistant" : "Open deck assistant"}
    aria-label=${enabled ? "Close deck assistant" : "Open deck assistant"}
  >
    <i className="ph-fill ph-sparkle" aria-hidden="true"></i>
  </button>`;
};
