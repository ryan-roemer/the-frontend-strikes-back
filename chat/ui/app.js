import { createElement, useSyncExternalStore } from "react";
import htm from "htm";
import { isEnabled, subscribe } from "../state.js";
import { Panel } from "./panel.js";

const html = htm.bind(createElement);

/**
 * The chat's root component.
 *
 * `Panel` is rendered unconditionally and HIDDEN when disabled, never unmounted.
 * Closing the chat has to be free: the transcript, the model session, and any
 * pending deck edits all live in the panel's subtree, and an unmount would
 * discard them. `hidden` is the whole mechanism.
 */
export const ChatApp = () => {
  const enabled = useSyncExternalStore(subscribe, isEnabled);
  return html`<${Panel} enabled=${enabled} />`;
};
