/**
 * Which answer's context is on screen, if any.
 *
 * The captured context itself IS the state -- there is no id to look up, because
 * there is nowhere to look it up. What was sent for a given turn exists in exactly
 * one place, the entry it was attached to in `use-conversation.js`, and the button
 * that opens this hands that object straight over.
 *
 * Module-level rather than React state for the same reason as `chat/tools/state.js`:
 * the button lives inside the chat panel and the sheet must render outside it, on
 * `#chat-root`. `.chat-panel` is `overflow: hidden`, so a scrim rendered within it
 * would be clipped to the panel it is supposed to cover.
 */
import { createStore } from "../store.js";

const store = createStore(null);

export const getShown = store.get;
export const subscribe = store.subscribe;

export const showContext = (context) => store.set(context ?? null);
export const hideContext = () => store.set(null);
