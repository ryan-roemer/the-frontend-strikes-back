import { createElement, useSyncExternalStore } from "react";
import htm from "htm";
import { isEnabled, subscribe } from "../state.js";
import { ToolsGate } from "../tools/gate.js";
import { Panel } from "./panel.js";

const html = htm.bind(createElement);

/**
 * The chat's root component.
 *
 * `Panel` is rendered unconditionally and HIDDEN when disabled, never unmounted.
 * Closing the chat has to be free: the transcript, the model session, and any
 * pending deck edits all live in the panel's subtree, and an unmount would
 * discard them. `hidden` is the whole mechanism.
 *
 * `ToolsGate` is the opposite on purpose: it renders nothing until the inspector
 * is opened, and unmounts when it closes. There is nothing in there worth
 * keeping -- a form and one result -- and being absent is what keeps the modal's
 * code off the initial load.
 *
 * Both live on this root rather than in the deck's tree because Spectacle's
 * `TemplateWrapper` is `transform`ed and `pointer-events: none`; see the note at
 * the top of `chat/index.js`.
 */
export const ChatApp = () => {
  const enabled = useSyncExternalStore(subscribe, isEnabled);
  return html`
    <${Panel} enabled=${enabled} />
    <${ToolsGate} />
  `;
};
