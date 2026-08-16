import { createElement, useSyncExternalStore } from "react";
import htm from "htm";
import { isOpen, subscribe, toggleOpen } from "./state.js";

const html = htm.bind(createElement);

/**
 * The plug, sitting next to the sparkle in the deck chrome.
 *
 * Hooks are safe here for the same reason they are safe in `ChatToggle` and
 * `DeckBridge`: this is rendered as an element, so it owns its own fiber. It
 * must not become a plain function call inside `Template`.
 *
 * It reuses `.chat-toggle` rather than defining its own button style, which is
 * not just tidiness -- `pointer-events: auto` lives on that class, and
 * Spectacle's `TemplateWrapper` is `pointer-events: none`. A separate class that
 * forgot the rule would render perfectly and ignore every click.
 *
 * THE BUTTON IS NOT THE MODAL. All this does is flip a boolean; the inspector
 * itself renders on `#chat-root`, outside the deck's scaled, non-interactive
 * template box. A `position: fixed` scrim inside a `transform`ed ancestor
 * positions against that ancestor rather than the viewport, so a modal rendered
 * here would be pinned to the slide, not the screen.
 */
export const ToolsToggle = () => {
  const open = useSyncExternalStore(subscribe, isOpen);

  return html`<button
    type="button"
    className=${`chat-toggle chat-toggle--tools${open ? " chat-toggle--on" : ""}`}
    onClick=${toggleOpen}
    aria-pressed=${open}
    title=${open ? "Close WebMCP tools" : "Open WebMCP tools"}
    aria-label=${open ? "Close WebMCP tools" : "Open WebMCP tools"}
  >
    <i className="ph-fill ph-plugs-connected" aria-hidden="true"></i>
  </button>`;
};
