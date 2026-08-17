/**
 * The patch log. The source of truth for every edit; the DOM is its projection.
 *
 * Recovered from `ef4c47f`, with one simplification the new addressing bought.
 *
 * UNDO REBUILDS FROM THE LOG rather than applying inverses, and that single
 * choice pays for itself three times:
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
 * WHAT CHANGED ON RECOVERY: the deleted version needed `chat/edit/locator.js` --
 * a structural path plus role plus a 40-character snippet -- because its
 * addresses were `data-chat-ref` attributes and React drops an attribute it does
 * not own when it recreates a node. Node ids come from the fiber tree instead,
 * and `resolveNode` re-walks on every call, so the address survives the remount
 * that killed the old one. That whole file is gone and the log keys on the id.
 *
 * Baselines are captured ONCE per (id, property) -- the first time that property
 * is touched -- so they always hold the deck's original value rather than the
 * value some earlier edit left behind.
 */
import { resolveNode } from "../harvest/index.js";
import { render } from "./sheet.js";

/**
 * How many edits to remember.
 *
 * Fifty is far past a demo and far short of a memory concern. Evicting the
 * oldest keeps its BASELINE, so a later reset can still restore the deck's true
 * original value for that property.
 */
const LIMIT = 50;

const patches = [];
const baselines = new Map();

/**
 * The text nodes of an element, in document order.
 *
 * The INDEX into this list is the stable address, and that distinction is the
 * whole reason this function is separate from the one below.
 */
const textNodesOf = (el) =>
  [...(el?.childNodes ?? [])].filter((n) => n.nodeType === 3);

/**
 * Which text node an edit should write to.
 *
 * The longest trimmed one is the sentence; the short ones are the whitespace
 * between inline elements.
 *
 * CHOSEN ONCE, THEN ADDRESSED BY INDEX FOREVER. "Longest" is a property of the
 * CURRENT text, so re-deciding it on every rebuild moves the target as soon as
 * an edit changes a length. Measured on slide 9's first bullet -- "The page
 * **registers** tools. The agent discovers and calls them.", two text nodes
 * either side of a `<strong>`: the edit shortened the longer one, the next
 * rebuild picked the other one as "longest", restored the original into it and
 * wrote the replacement into it too. The bullet came out as
 * "CHANGEDregistersCHANGED", and reset could not put it back because both
 * halves had been overwritten.
 *
 * The index is stable because `childNodes` order is; a `nodeValue` write never
 * adds or removes a node, which is the other half of why this channel is safe.
 */
const mainTextIndex = (el) => {
  const nodes = textNodesOf(el);
  let best = -1;
  let longest = -1;
  nodes.forEach((node, i) => {
    const length = (node.nodeValue ?? "").trim().length;
    if (length > longest) {
      longest = length;
      best = i;
    }
  });
  return best;
};

const textNodeAt = (el, index) => textNodesOf(el)[index] ?? null;

/**
 * The exact string a text edit will overwrite.
 *
 * NOT the node's harvested text. Those differ whenever a node has inline markup:
 * slide 9's second bullet harvests as "One API: document.modelContext" but its
 * main text node holds only "One API: " -- the rest is a `<code>` element. A
 * baseline taken from the harvest therefore restores the WHOLE flattened string
 * into the first text node and leaves the markup beside it, so "undo" produced
 * "One API: document.modelContextdocument.modelContext".
 *
 * Measured: reset left the deck visibly different from how it started, while
 * reporting success.
 */
export const mainTextValue = (el) => {
  const index = mainTextIndex(el);
  if (index < 0) return null;
  return { index, value: textNodeAt(el, index)?.nodeValue ?? null };
};

/** Whether a text edit here would only cover part of what is on screen. */
export const isMixed = (el) => {
  if (!el) return false;
  const withText = textNodesOf(el).filter((n) => (n.nodeValue ?? "").trim());
  return withText.length > 1 || el.children.length > 0;
};

/**
 * Apply one patch to the DOM.
 *
 * `nodeValue`, NEVER `textContent`.
 *
 * `textContent = x` removes every child node and inserts one new text node.
 * React's fiber still holds references to the nodes it removed, so the next
 * commit that touches that subtree can call `removeChild` on a node that is no
 * longer a child, Chrome throws `NotFoundError`, and React unmounts the whole
 * root -- a blank deck, mid-talk. There is real content in this deck shaped
 * exactly for that trap: `<${Text}><${Icon} name="hand-waving" /> I'm Ryan
 * Roemer</${Text}>` renders an `<i>` followed by a text node.
 *
 * Writing `nodeValue` on an existing text node preserves every reference React
 * holds, and React overwrites it only if ITS OWN string for that position
 * changes -- which, for this deck's static slide content, means never during
 * navigation.
 */
const applyDom = (patch) => {
  if (patch.kind === "css") return;

  const node = resolveNode(patch.id);
  const el = node?.element;
  if (!el) {
    // Marked, not thrown: an address that stopped resolving is a thing to
    // report, and a rebuild that throws halfway leaves the deck half-restored.
    patch.stale = true;
    return;
  }
  patch.stale = false;

  if (patch.kind === "text") {
    // By the index recorded when the patch was made, never by re-deciding which
    // node is longest -- see `mainTextIndex`.
    const target = textNodeAt(el, patch.textIndex);
    if (!target) {
      patch.stale = true;
      return;
    }
    target.nodeValue = patch.text;
    return;
  }

  if (patch.kind === "class") {
    el.classList.toggle(patch.className, patch.on);
  }
};

/**
 * Re-stamp the CSS hooks the sheet's selectors depend on.
 *
 * Addressing needs no attribute -- node ids come from the fiber tree. But a
 * stylesheet rule has to name something the cascade understands, so a styled
 * node gets `data-deck-ref="9.3"` and the rule targets `[data-deck-ref="9.3"]`.
 *
 * Safe to write: React never manages an attribute absent from its props, so it
 * survives every re-render and is lost only on a remount -- which is exactly
 * when `rebuild()` runs and puts it back.
 *
 * CLEARED FIRST, every time. Stamping without unstamping left an attribute
 * behind after a reset -- harmless to look at, and exactly the kind of residue
 * that makes "is the deck really back to normal?" unanswerable.
 */
const stampRefs = () => {
  for (const el of document.querySelectorAll("[data-deck-ref]")) {
    delete el.dataset.deckRef;
  }
  for (const patch of patches) {
    if (patch.kind !== "css" || !patch.id) continue;
    const el = resolveNode(patch.id)?.element;
    if (el) el.dataset.deckRef = patch.id;
  }
};

/**
 * The text a node currently shows, if an edit changed it.
 *
 * THE HARVEST AND THE DECK DIVERGE THE MOMENT ANYTHING IS EDITED, and that is
 * not a bug in either: the harvest reads React's fibers, which hold what the
 * deck was AUTHORED with, while an edit writes `nodeValue` on the DOM. React
 * never learns about it -- that is precisely what makes the edit survive
 * re-renders.
 *
 * So a caller that has just changed something and then asks what is on the slide
 * gets the old wording back, which reads as the edit having failed. This is the
 * overlay that closes that gap: the log knows what it wrote, so anything
 * rendering slide content asks here first.
 */
const patchedText = (id) => {
  for (let i = patches.length - 1; i >= 0; i -= 1) {
    const patch = patches[i];
    if (patch.kind === "text" && patch.id === id) return patch.text;
  }
  return null;
};

/** A slide's nodes with any edits applied, for anything showing them. */
export const withEdits = (nodes) =>
  nodes.map((node) => {
    const text = patchedText(node.id);
    return text === null ? node : { ...node, text, edited: true };
  });

/** Put every touched property back to the value the deck shipped with. */
const restoreBaselines = () => {
  for (const [key, baseline] of baselines) {
    const [id] = key.split("|");
    const el = resolveNode(id)?.element;
    if (!el) continue;

    if (baseline.kind === "text") {
      const target = textNodeAt(el, baseline.index);
      if (target) target.nodeValue = baseline.value;
    } else if (baseline.kind === "class") {
      el.classList.toggle(baseline.className, baseline.value);
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
  stampRefs();
  for (const patch of patches) applyDom(patch);
};

/** Record the deck's original value for a property, the first time it is touched. */
export const captureBaseline = (id, property, baseline) => {
  const key = `${id}|${property}`;
  if (!baselines.has(key)) baselines.set(key, baseline);
};

export const push = (patch) => {
  patches.push(patch);
  if (patches.length > LIMIT) {
    // Drop the oldest, but KEEP its baseline: a later reset must still be able
    // to restore the deck's true original value for that property.
    patches.splice(0, 1);
  }
  rebuild();
  return patch;
};

export const undo = () => {
  const patch = patches.pop();
  if (!patch) return null;
  rebuild();
  return patch;
};

/**
 * Back to the deck as it shipped.
 *
 * ORDER MATTERS: rebuild runs while the baselines are still there, and only then
 * are they cleared. Clearing first would leave every edit applied with nothing
 * left to restore from.
 */
export const reset = () => {
  const count = patches.length;
  patches.length = 0;
  rebuild();
  baselines.clear();
  return count;
};

/**
 * The edit log, as data.
 *
 * NO `canRedo`, and no redo. The log carried a `redoStack`, a `redo()` and a
 * `canRedo` flag, and nothing could reach any of them: no tool exposed redo, so
 * `canRedo` was a field agents were told about and could never act on. Undo plus
 * reset is the whole surface, which is the honest description of what exists.
 */
export const summary = () => ({
  count: patches.length,
  canUndo: patches.length > 0,
  labels: patches.map((p) => p.label),
  stale: patches.filter((p) => p.stale).map((p) => p.label),
});
