import { keyOf, resolve } from "./locator.js";
import { render } from "./sheet.js";
import { invalidate } from "../agent/knowledge.js";

/**
 * The patch log. The source of truth for every edit; the DOM is its projection.
 *
 * Undo REBUILDS FROM THE LOG rather than applying inverses, and that single choice
 * pays for itself three times:
 *
 *   1. One code path. Apply, undo, redo, reset, and recovering from a remount are
 *      all `rebuild()`. There is no second implementation to keep in agreement.
 *   2. Stacked edits are free. Three font-size changes to one heading undo to the
 *      second, then the first, then the original, with no per-patch inverse to
 *      compute -- and crucially without READING the DOM at undo time, which would
 *      be wrong if a remount happened in between.
 *   3. CSS patches need no inverse at all: the sheet is regenerated from whatever
 *      patches remain, so removing one removes its rule.
 *
 * Baselines are captured ONCE per (element, property) -- the first time that
 * property is touched -- so they always hold the deck's original value rather than
 * the value some earlier edit left behind.
 */

const LIMIT = 50;

const patches = [];
const redoStack = [];

/** `${locatorKey}|${property}` -> the deck's original value. */
const baselines = new Map();

const listeners = new Set();

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const notify = () => {
  for (const fn of listeners) fn(summary());
};

export const summary = () => ({
  count: patches.length,
  canUndo: patches.length > 0,
  canRedo: redoStack.length > 0,
  labels: patches.map((patch) => patch.label),
  stale: patches.filter((patch) => patch.stale).map((patch) => patch.label),
});

/** Text nodes of an element, in document order. Index into this is stable. */
const textNodesOf = (el) =>
  [...el.childNodes].filter((node) => node.nodeType === 3);

const baseline = (key, read) => {
  if (!baselines.has(key)) baselines.set(key, read());
  return baselines.get(key);
};

/**
 * Apply one patch to the DOM.
 *
 * `nodeValue`, NEVER `textContent`.
 *
 * `textContent = x` removes every child node and inserts one new text node. React's
 * fiber still holds references to the nodes it removed, so the next commit that
 * touches that subtree can call `removeChild` on a node that is no longer a child,
 * Chrome throws `NotFoundError`, and React unmounts the whole root -- a blank deck,
 * mid-talk. There is real content in this deck shaped exactly for that trap, e.g.
 * `<${Text}><${Icon} name="hand-waving" /> I'm Ryan Roemer</${Text}>`, which renders
 * an `<i>` followed by a text node.
 *
 * Writing `nodeValue` on an existing text node preserves every reference React
 * holds, and React overwrites it only if ITS OWN string for that position changes
 * -- which, for this deck's static slide content, means never during navigation.
 */
const applyDom = (patch) => {
  if (patch.kind === "css") return true; // The sheet handles these.

  const el = resolve(patch.locator);
  if (!el) {
    patch.stale = true;
    return false;
  }
  patch.stale = false;

  if (patch.kind === "text") {
    const nodes = textNodesOf(el);
    const node = nodes[patch.nodeIndex];
    if (!node) {
      patch.stale = true;
      return false;
    }
    node.nodeValue = patch.text;
    return true;
  }

  if (patch.kind === "class") {
    el.classList.toggle(patch.className, patch.on);
    return true;
  }

  return false;
};

/** Put every touched property back to the deck's original value. */
const restoreBaselines = () => {
  for (const [key, value] of baselines) {
    const [, kind] = key.split("|");
    const locator = value.locator;
    if (!locator) continue;
    const el = resolve(locator);
    if (!el) continue;

    if (kind === "text") {
      const node = textNodesOf(el)[value.nodeIndex];
      if (node) node.nodeValue = value.text;
    } else if (kind.startsWith("class:")) {
      el.classList.toggle(value.className, value.present);
    }
  }
};

/**
 * Recompute the entire DOM + CSS state from the log.
 *
 * Restore-then-replay, in log order. Idempotent, which is what lets the watchdog
 * call exactly this after a remount.
 */
export const rebuild = () => {
  restoreBaselines();
  render(patches);
  for (const patch of patches) applyDom(patch);
  // The assistant should be able to answer about the deck as it is NOW, including
  // its own edits.
  invalidate();
  notify();
};

/**
 * Record a text edit and apply it.
 *
 * Returns `{ ok, partial }`. `partial` is true when the element holds more than one
 * text node -- an inline `em()` or icon -- so only the longest run was replaced and
 * the caller should say so rather than claim a clean rewrite.
 */
export const setText = (el, locator, text, label) => {
  const nodes = textNodesOf(el);
  if (!nodes.length) return { ok: false };

  // The longest text node is the sentence; the short ones are whitespace between
  // inline elements.
  let nodeIndex = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (
      nodes[i].nodeValue.trim().length >
      nodes[nodeIndex].nodeValue.trim().length
    ) {
      nodeIndex = i;
    }
  }

  const key = `${keyOf(locator)}|text`;
  baseline(key, () => ({
    locator,
    nodeIndex,
    text: nodes[nodeIndex].nodeValue,
  }));

  push({ kind: "text", locator, nodeIndex, text, label });
  return {
    ok: true,
    partial:
      nodes.filter((n) => n.nodeValue.trim()).length > 1 ||
      el.children.length > 0,
  };
};

export const setClass = (el, locator, className, on, label) => {
  const key = `${keyOf(locator)}|class:${className}`;
  baseline(key, () => ({
    locator,
    className,
    present: el.classList.contains(className),
  }));
  push({ kind: "class", locator, className, on, label });
  return { ok: true };
};

/** A CSS rule. No baseline needed: removing the patch removes the rule. */
export const setCss = (selector, declarations, label) => {
  push({ kind: "css", selector, declarations, label });
  return { ok: true };
};

const push = (patch) => {
  patches.push(patch);
  if (patches.length > LIMIT) {
    // Drop the oldest, but KEEP its baseline: a later reset must still be able to
    // restore the deck's true original value for that property.
    patches.splice(0, 1);
  }
  redoStack.length = 0;
  rebuild();
};

export const undo = () => {
  const patch = patches.pop();
  if (!patch) return null;
  redoStack.push(patch);
  rebuild();
  return patch;
};

export const redo = () => {
  const patch = redoStack.pop();
  if (!patch) return null;
  patches.push(patch);
  rebuild();
  return patch;
};

/** Back to the deck as it loaded. */
export const reset = () => {
  patches.length = 0;
  redoStack.length = 0;
  rebuild();
  baselines.clear();
};
