/* global localStorage:false, location:false, URLSearchParams:false */

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
 * That is why the flag is no longer PERSISTED across reloads either. It used to be,
 * to save a click -- but a panel that reappears by itself after a refresh is a panel
 * you have to remember to close before presenting, and forgetting costs you the
 * opening slide in front of an audience. Toggling still works within a session; a
 * reload is a clean slate.
 *
 * `?chat` (or `?chat=true`) opens it on load, for rehearsing the assistant itself
 * without clicking every time.
 */

/** Retained only to clear a value written by an older build. */
const LEGACY_KEY = "chat:enabled";

const listeners = new Set();

/**
 * The URL is the only thing that can open the panel before a click.
 *
 * Accepts a bare `?chat` as well as `?chat=true`, because a flag you have to
 * remember the value of is a flag you will get wrong at the podium.
 */
const fromUrl = () => {
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has("chat")) return false;
    const value = params.get("chat");
    return value === null || value === "" || value === "true" || value === "1";
  } catch {
    return false;
  }
};

// Drop the persisted flag, so a profile that presented with the chat open once does
// not keep reopening it. Best-effort: storage may be unavailable entirely.
try {
  localStorage.removeItem(LEGACY_KEY);
} catch {
  // Nothing to clean up, or no storage. Either way the default below is closed.
}

let enabled = fromUrl();

export const isEnabled = () => enabled;

export const setEnabled = (next) => {
  if (next === enabled) return;
  enabled = next;
  for (const fn of listeners) fn(enabled);
};

export const toggleEnabled = () => setEnabled(!enabled);

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
