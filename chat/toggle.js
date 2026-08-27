import { createElement } from "react";
import htm from "htm";
import { CHAT_KEY_HINT } from "./keys.js";
import { chatStore, toggleEnabled } from "./state.js";
import { Toggle } from "./ui/toggle.js";

const html = htm.bind(createElement);

/**
 * The sparkle, sitting next to Spectacle's fullscreen button in the deck chrome.
 *
 * All the mechanism -- and the two traps it works around -- is in `ui/toggle.js`.
 *
 * The chord is named in the label because a tooltip on the button is the only place
 * anybody would ever discover it.
 */
export const ChatToggle = () =>
  html`<${Toggle}
    store=${chatStore}
    onToggle=${toggleEnabled}
    icon="ph-sparkle"
    labelOn=${`Close deck assistant (${CHAT_KEY_HINT})`}
    labelOff=${`Open deck assistant (${CHAT_KEY_HINT})`}
  />`;
