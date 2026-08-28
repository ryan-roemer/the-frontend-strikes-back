/**
 * The patch log. The source of truth for every edit; the DOM is its projection.
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
 * THE LOG KEYS ON NODE ID, which is what lets it stay this simple. Ids come from the fiber
 * tree and `resolveNode` re-walks on every call, so an address survives a remount --
 * unlike a `data-chat-ref` attribute, which React drops when it recreates a node, and
 * which would need a structural path plus role plus a text snippet to recover from.
 *
 * Baselines are captured ONCE per (id, property) -- the first time that property
 * is touched -- so they always hold the deck's original value rather than the
 * value some earlier edit left behind.
 */
import { resolveNode } from "../harvest/index.js";
import { normalize } from "../harvest/nodes.js";
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
 * One tool call's worth of patches, grouped so undo matches what was asked for.
 *
 * A find-and-replace across a slide writes one patch per text run it touched --
 * eleven of them, for "WebMCP" across the deck. Undoing that one run at a time
 * would take eleven calls to put back one change the caller made once, and the
 * first ten of those leave the deck in a state nobody asked for.
 *
 * So a patch belongs to a GROUP, one per call, and undo pops the whole group.
 * Single-patch edits are a group of one, which costs nothing and keeps every
 * path through the log identical.
 */
let nextGroup = 1;

/** How many distinct edits a set of patches represents. */
const countGroups = (list) => new Set(list.map((p) => p.group)).size;

/**
 * Every text node under an element, in document order.
 *
 * DESCENDANTS, NOT JUST CHILDREN, and that is what makes substring editing work
 * on the third of this deck that carries inline markup. Bullet 9.3 is
 * `#text "One API: "` followed by `<code>document.modelContext</code>`; a walk
 * of direct children cannot see the code element's text at all, so a rename that
 * should touch it silently does not.
 *
 * The INDEX into this list is the stable address, and that distinction is the
 * whole reason this function is separate from the one below. It stays stable for
 * the same reason it did when this only walked children: a `nodeValue` write
 * never adds or removes a node, so nothing here renumbers.
 */
const textRuns = (el) => {
  if (!el) return [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const runs = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    runs.push(node);
  }
  return runs;
};

/**
 * Which text node an edit should write to.
 *
 * The longest trimmed one is the sentence; the short ones are the whitespace
 * between inline elements.
 *
 * CHOSEN ONCE, THEN ADDRESSED BY INDEX FOREVER. "Longest" is a property of the CURRENT
 * text, so re-deciding it on every rebuild moves the target as soon as an edit changes a
 * length. On a bullet with two text nodes either side of a `<strong>`, shortening the
 * longer one makes the next rebuild pick the other as "longest", restore the original into
 * it AND write the replacement into it -- "CHANGEDregistersCHANGED", with both halves
 * overwritten so reset cannot recover it.
 *
 * The index is stable because `childNodes` order is; a `nodeValue` write never adds or
 * removes a node, which is the other half of why this channel is safe.
 */
const mainRunIndex = (el) => {
  const runs = textRuns(el);
  let best = -1;
  let longest = -1;
  runs.forEach((node, i) => {
    const length = (node.nodeValue ?? "").trim().length;
    if (length > longest) {
      longest = length;
      best = i;
    }
  });
  return best;
};

const textRunAt = (el, index) => textRuns(el)[index] ?? null;

/** Every run's current value, for callers computing a substring replacement. */
export const runsOf = (el) =>
  textRuns(el).map((node, index) => ({ index, value: node.nodeValue ?? "" }));

/**
 * The exact string a text edit will overwrite.
 *
 * NOT the node's harvested text. The two differ whenever a node has inline markup: a
 * bullet harvesting as "One API: document.modelContext" may hold only "One API: " in its
 * main text node, the rest being a `<code>` element. A baseline taken from the harvest
 * restores the WHOLE flattened string into that one node and leaves the markup beside it,
 * so undo yields "One API: document.modelContextdocument.modelContext" -- a deck visibly
 * different from how it started, reported as success.
 */
export const mainTextValue = (el) => {
  const index = mainRunIndex(el);
  if (index < 0) return null;
  return { index, value: textRunAt(el, index)?.nodeValue ?? null };
};

/** Whether a whole-node text edit here would only cover part of what is on screen. */
export const isMixed = (el) => {
  if (!el) return false;
  return textRuns(el).filter((n) => (n.nodeValue ?? "").trim()).length > 1;
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
    // run is longest -- see `mainRunIndex`.
    const target = textRunAt(el, patch.runIndex);
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
  const touched = patches.some((p) => p.kind === "text" && p.id === id);
  if (!touched) return null;

  // READ THE ELEMENT, DON'T REASSEMBLE THE PATCHES. A substring replace writes
  // one patch per run it changed, so the node's text is now the runs it did
  // change interleaved with the ones it did not -- and the log only holds the
  // first kind. `rebuild()` has already run by the time anything reads this, so
  // the element IS the assembled answer.
  //
  // It is also the honest one: a patch `applyDom` marked stale did not land, and
  // reading the element reports what the slide says rather than what the log
  // intended it to say.
  const el = resolveNode(id)?.element;
  if (el) return normalize(el.textContent ?? "");

  // No element to read: fall back to the newest whole-node patch, which is the
  // best available guess and the only shape that ever had one.
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

/**
 * The same overlay, for MATCHING A PHRASE against a node or QUOTING IT BACK.
 *
 * `withEdits` is for showing a slide's content, and code panes are where the two jobs
 * part company. An edited pane's element holds its whole source, so `withEdits` gives
 * that node six hundred characters of source as its text -- right for `get_slide`, whose
 * business is the content, and wrong here twice over. `locate.js` addresses a pane by its
 * FILENAME, the only name it has, so an edit anywhere inside it would make the pane
 * unaddressable; and a receipt quoting the node back would print the file instead of
 * naming it.
 *
 * So a pane keeps its filename and carries its current source alongside, which is what
 * `locate.js`'s `bySource` tier searches. Every other node is `withEdits` exactly.
 */
export const asShown = (nodes) => {
  const shown = withEdits(nodes);
  return shown.map((node, i) =>
    node.edited && node.role === "code"
      ? { ...node, text: nodes[i].text, source: node.text }
      : node,
  );
};

/** Put every touched property back to the value the deck shipped with. */
const restoreBaselines = () => {
  for (const [key, baseline] of baselines) {
    const [id] = key.split("|");
    const el = resolveNode(id)?.element;
    if (!el) continue;

    if (baseline.kind === "text") {
      const target = textRunAt(el, baseline.index);
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

/**
 * Add one call's worth of patches to the log, as a single undoable group.
 *
 * ONE REBUILD FOR THE WHOLE GROUP. Pushing eleven patches one at a time would
 * restore-and-replay the entire log eleven times, and the intermediate states
 * are visible on screen -- a deck that flickers through ten wrong versions of
 * itself on the way to the right one.
 */
export const pushAll = (incoming, label) => {
  const list = incoming.filter(Boolean);
  if (!list.length) return null;

  const group = nextGroup++;
  const said = label ?? list[0].label;
  for (const patch of list) {
    patch.group = group;
    // Carried on every patch rather than in a side table, so a patch that is
    // evicted or filtered out takes its group's description with it and no
    // lookup can outlive what it describes.
    patch.groupLabel = said;
    patches.push(patch);
  }

  // Evict by GROUP, never by patch. Dropping the oldest single patch out of a
  // replace-across-a-slide leaves the rest of that group in the log, so undo
  // reports one change and puts back part of another.
  while (patches.length > LIMIT && patches.length) {
    const oldest = patches[0].group;
    // Baselines are KEPT: a later reset must still restore the deck's true
    // original value for a property whose patch has aged out.
    while (patches.length && patches[0].group === oldest) patches.shift();
  }

  rebuild();
  return { group, label: label ?? list[0].label, count: list.length };
};

export const push = (patch) => pushAll([patch], patch.label);

/** Undo the newest group -- one tool call's worth, however many patches it wrote. */
export const undo = () => {
  const group = patches.at(-1)?.group;
  if (group === undefined) return null;

  const removed = [];
  while (patches.length && patches.at(-1).group === group) {
    removed.unshift(patches.pop());
  }
  rebuild();
  return { label: labelOf(removed), count: removed.length };
};

/**
 * Drop every edit that targets one slide, leaving the rest of the log alone.
 *
 * NO INVERSES NEEDED, which is the log-rebuilds-everything design paying out
 * again: `rebuild()` restores every baseline and replays whatever patches remain,
 * so removing a slide's patches restores exactly that slide. Deck-wide variable
 * patches carry no `id` and so are correctly untouched.
 */
export const dropSlide = (slide) => {
  const prefix = `${slide}.`;
  const kept = patches.filter((p) => !(p.id && p.id.startsWith(prefix)));
  if (kept.length === patches.length) return 0;

  // COUNTED IN GROUPS, like everything else a caller is told. A replace across
  // this slide is one thing they did, and reporting it as the six text runs it
  // took to carry out describes the implementation rather than the change.
  const gone = patches.filter((p) => p.id && p.id.startsWith(prefix));
  const removed = countGroups(gone);

  // A DECK-WIDE EDIT CAN BE HALF-REMOVED BY THIS, and its label then describes
  // work that is no longer all there: replacing a word across eleven nodes and
  // then resetting one slide leaves ten, still labelled "in 11 nodes". Undoing
  // it later would report putting back eleven and put back ten.
  //
  // The survivors are marked rather than relabelled, because there is no one
  // format to regenerate -- every op writes its own label -- and "partly reset"
  // is the fact a reader needs anyway.
  const split = new Set(gone.map((p) => p.group));
  for (const patch of kept) {
    if (!split.has(patch.group) || /partly reset/.test(patch.groupLabel)) {
      continue;
    }
    patch.groupLabel = `${patch.groupLabel} (partly reset)`;
  }

  patches.length = 0;
  patches.push(...kept);
  rebuild();
  return removed;
};

/**
 * Back to the deck as it shipped.
 *
 * ORDER MATTERS: rebuild runs while the baselines are still there, and only then
 * are they cleared. Clearing first would leave every edit applied with nothing
 * left to restore from.
 */
export const reset = () => {
  const count = countGroups(patches);
  patches.length = 0;
  rebuild();
  baselines.clear();
  return count;
};

/** One group's description, from whichever of its patches survive. */
const labelOf = (list) => list[0]?.groupLabel ?? list[0]?.label ?? "an edit";

/**
 * The edit log, as data.
 *
 * COUNTED IN GROUPS, NOT PATCHES, because a group is what a caller did and a
 * patch is how it was carried out. Replacing a word across a slide is one edit
 * to the person who asked for it and one press of undo to put back; reporting it
 * as "6 edits" invites six.
 *
 * NO `canRedo`, and no redo. The log carried a `redoStack`, a `redo()` and a
 * `canRedo` flag, and nothing could reach any of them: no tool exposed redo, so
 * `canRedo` was a field agents were told about and could never act on. Undo plus
 * reset is the whole surface, which is the honest description of what exists.
 */
export const summary = () => {
  const groups = [...new Set(patches.map((p) => p.group))].map((group) =>
    patches.filter((p) => p.group === group),
  );

  return {
    count: groups.length,
    canUndo: groups.length > 0,
    labels: groups.map(labelOf),
    stale: groups.filter((g) => g.some((p) => p.stale)).map(labelOf),
  };
};
