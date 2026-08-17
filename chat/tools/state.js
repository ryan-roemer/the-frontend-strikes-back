/**
 * Whether the tool inspector is open.
 *
 * Deliberately its own boolean rather than a mode of `chat/state.js`. The chat
 * panel is a persistent floating window whose whole point is that closing it
 * keeps the transcript; the inspector is a scrim you open, run one tool in, and
 * dismiss. Sharing one flag would mean either the chat cannot be open behind the
 * modal or the modal cannot outlive a chat close, and both are wrong.
 *
 * CLOSED ON LOAD, ALWAYS, and not persisted -- the same reasoning as the chat.
 * A modal that reappears by itself after a refresh is a modal covering slide 1
 * in front of an audience.
 *
 * `?tools` opens it. `?tool=` (singular) additionally names the tool to select,
 * which makes any single tool a link -- worth it for a talk, where "open the deck
 * on find_node" is a thing you want to do from a bookmark rather than from three
 * clicks on stage.
 */
import { createStore } from "../store.js";
import { flag, param } from "../url.js";

/** The tool named by `?tool=`, if any. Validated against the registry, not here. */
export const initialTool = () => param("tool");

const store = createStore(flag("tools") || !!initialTool());

/** The store itself, for `ui/toggle.js` -- see the note in `chat/state.js`. */
export { store as toolsStore };

export const isOpen = store.get;
export const setOpen = store.set;
export const subscribe = store.subscribe;

export const toggleOpen = () => store.set(!store.get());
