/* global location:false, URLSearchParams:false */

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
 */

const listeners = new Set();

/**
 * The URL is the only thing that can open the inspector before a click.
 *
 * Bare `?tools` as well as `?tools=true`, matching `?chat` and `?mcp`. `?tool=`
 * (singular) additionally names the tool to select, which makes any single tool
 * a link -- worth it for a talk, where "open the deck on find_node" is a thing
 * you want to do from a bookmark rather than from three clicks on stage.
 */
const params = () => {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams("");
  }
};

const flagged = (name) => {
  const search = params();
  if (!search.has(name)) return false;
  const value = search.get(name);
  return value === null || value === "" || value === "true" || value === "1";
};

/** The tool named by `?tool=`, if any. Validated against the registry, not here. */
export const initialTool = () => params().get("tool") || null;

let open = flagged("tools") || !!initialTool();

export const isOpen = () => open;

export const setOpen = (next) => {
  if (next === open) return;
  open = next;
  for (const fn of listeners) fn(open);
};

export const toggleOpen = () => setOpen(!open);

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
