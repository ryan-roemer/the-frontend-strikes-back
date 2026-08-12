/* global localStorage:false */

/**
 * Whether the chat is on, and the fact that the answer survives a reload.
 *
 * One boolean does two jobs, deliberately. "Enabled" and "panel visible" are the
 * same state: the panel is HIDDEN when disabled, never unmounted, so a
 * conversation and any pending edits are still there when it comes back. That is
 * the whole reason the panel lives on its own root -- an unmount would take the
 * transcript with it.
 *
 * Persisting it also drives the model preload: a deck that loads with the chat
 * already on can create the `LanguageModel` session before the first keystroke,
 * so the first question streams immediately instead of waiting on session setup.
 *
 * Storage is best-effort. A deck presented from a locked-down profile (or with
 * storage disabled) still works; it just forgets the flag between reloads, which
 * is a far better failure than a deck that throws on load.
 */

const KEY = "chat:enabled";

const listeners = new Set();

const read = () => {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
};

let enabled = read();

export const isEnabled = () => enabled;

export const setEnabled = (next) => {
  if (next === enabled) return;
  enabled = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    // Non-fatal: the flag is a convenience, not state anything depends on.
  }
  for (const fn of listeners) fn(enabled);
};

export const toggleEnabled = () => setEnabled(!enabled);

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
