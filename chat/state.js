/**
 * Whether the chat is on.
 *
 * One boolean does two jobs, deliberately. "Enabled" and "panel visible" are the
 * same state: the panel is HIDDEN when disabled, never unmounted, so a
 * conversation and any pending edits are still there when it comes back. That is
 * the whole reason the panel lives on its own root -- an unmount would take the
 * transcript with it.
 *
 * CLOSED ON LOAD, ALWAYS. This deck is a talk first and an assistant second: the
 * audience should see slides, and a floating window over slide 1 is the wrong
 * first impression. The sparkle in the deck chrome is how it opens.
 *
 * NOT PERSISTED across reloads, for the same reason: a panel that reappears by itself
 * after a refresh is one you have to remember to close before presenting, and forgetting
 * costs the opening slide in front of an audience. Toggling works within a session; a
 * reload is a clean slate.
 *
 * `?chat` (or `?chat=true`) opens it on load, for rehearsing the assistant itself
 * without clicking every time -- see `chat/url.js` for why bare flags count.
 */
import { createStore } from "./store.js";
import { flag } from "./url.js";

/** Retained only to clear a value written by an older build. */
const LEGACY_KEY = "chat:enabled";

// Drop the persisted flag, so a profile that presented with the chat open once does
// not keep reopening it. Best-effort: storage may be unavailable entirely.
try {
  localStorage.removeItem(LEGACY_KEY);
} catch {
  // Nothing to clean up, or no storage. Either way the default below is closed.
}

const store = createStore(flag("chat"));

/** The store itself, for `ui/toggle.js`'s `useSyncExternalStore`. A stable object:
 *  passing `{ get, subscribe }` built at render time would resubscribe every render. */
export { store as chatStore };

export const isEnabled = store.get;
export const setEnabled = store.set;
export const subscribe = store.subscribe;

export const toggleEnabled = () => store.set(!store.get());
