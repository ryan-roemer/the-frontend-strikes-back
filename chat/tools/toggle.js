import { createElement } from "react";
import htm from "htm";
import { TOOLS_KEY_HINT } from "../keys.js";
import { toggleOpen, toolsStore } from "./state.js";
import { Toggle } from "../ui/toggle.js";

const html = htm.bind(createElement);

/**
 * The plug, sitting next to the sparkle in the deck chrome.
 *
 * All the mechanism -- and the two traps it works around -- is in `ui/toggle.js`.
 */
export const ToolsToggle = () =>
  html`<${Toggle}
    store=${toolsStore}
    onToggle=${toggleOpen}
    icon="ph-plugs-connected"
    labelOn=${`Close WebMCP tools (${TOOLS_KEY_HINT})`}
    labelOff=${`Open WebMCP tools (${TOOLS_KEY_HINT})`}
    modifier="chat-toggle--tools"
  />`;
