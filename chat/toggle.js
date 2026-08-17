import { createElement } from "react";
import htm from "htm";
import { chatStore, toggleEnabled } from "./state.js";
import { Toggle } from "./ui/toggle.js";

const html = htm.bind(createElement);

/**
 * The sparkle, sitting next to Spectacle's fullscreen button in the deck chrome.
 *
 * All the mechanism -- and the two traps it works around -- is in `ui/toggle.js`.
 */
export const ChatToggle = () =>
  html`<${Toggle}
    store=${chatStore}
    onToggle=${toggleEnabled}
    icon="ph-sparkle"
    labelOn="Close deck assistant"
    labelOff="Open deck assistant"
  />`;
