/**
 * How big the chat's text is, as a multiplier on the sizes in `chat.css`.
 *
 * Every text `font-size` there is `calc(Npx * var(--chat-fs, 1))`, so one custom
 * property on `<html>` scales the panel and both sheets together. ON `<html>` AND NOT
 * THE PANEL because the sheets are siblings of it, not children.
 *
 * Icons in fixed-size buttons are NOT scaled. The buttons are 26px boxes, and a glyph
 * that grows inside one stops fitting well before the text around it gets readable.
 *
 * THE DEFAULT IS ONE STEP UP from the sizes `chat.css` was tuned at. Those read fine at
 * a desk and too small from a projector.
 *
 * PERSISTED, unlike the open/closed flags in `state.js`. This one is a preference for
 * the screen, the same as the panel geometry: putting it back after a reload is the
 * point, and a bigger font never covers a slide by itself.
 */
import { createStore } from "./store.js";

const KEY = "chat:font-scale";

const STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const DEFAULT = 2;

const load = () => {
  try {
    const i = STEPS.indexOf(Number(localStorage.getItem(KEY)));
    return i === -1 ? DEFAULT : i;
  } catch {
    return DEFAULT;
  }
};

const store = createStore(load());

const apply = (i) => {
  document.documentElement.style.setProperty("--chat-fs", String(STEPS[i]));
};

apply(store.get());
store.subscribe((i) => {
  apply(i);
  try {
    localStorage.setItem(KEY, String(STEPS[i]));
  } catch {
    // Best effort, same as the panel geometry.
  }
});

/** The store itself, for `useSyncExternalStore` -- see the note in `state.js`. */
export { store as fontScaleStore };

export const scaleOf = (i) => STEPS[i];
export const canShrink = (i) => i > 0;
export const canGrow = (i) => i < STEPS.length - 1;

export const shrink = () => store.set(Math.max(0, store.get() - 1));
export const grow = () =>
  store.set(Math.min(STEPS.length - 1, store.get() + 1));
