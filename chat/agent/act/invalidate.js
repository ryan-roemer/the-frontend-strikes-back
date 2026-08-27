/**
 * Telling the model that a slide it holds has changed underneath it.
 *
 * THE FAILURE THIS PREVENTS was written down before it could happen
 * (`docs/chat-handoff.md` §10, "Invalidating a pinned slide when the deck is edited"),
 * because nothing in the chat could edit yet. Now it can, so it is live: a slide is pinned
 * into the preface at turn 2, the model changes its wording at turn 5, and at turn 7
 * "what does this slide say?" is answered from the pin -- fluently, confidently, and about
 * text the audience can see is no longer there.
 *
 * READ FROM `structuredContent`, WHICH IS WHY IT IS DECLARED. Every editing tool already
 * reports the nodes it touched as data rather than only as prose (`mcp/shape.js` exists for
 * this), so working out what to invalidate is a field access rather than a regex over a
 * receipt. That is the seam paying for itself somewhere its author did not have in mind.
 *
 * TEXT ONLY. A pin carries a slide's WORDING, so a change that cannot alter wording cannot
 * make one stale -- `style_node` and `set_deck_variable` both fall out here, and turning the
 * bullets yellow does not cost a re-pin.
 *
 * WHAT THIS DOES NOT COVER, stated plainly because it will look like a bug: an edit made by
 * an EXTERNAL host -- a browser extension calling the same registered tools -- does not pass
 * through here, so a pin can still go stale that way. The fix when it matters is the seam
 * `docs/webmcp-handoff.md` §6 already describes: a `subscribe()` on `edit/patches.js` that
 * fires on every apply, undo and reset, with this module as its subscriber instead of the
 * call in `respond.js`. It is left undone rather than guessed at, because it only pays off
 * when a host and the in-page model are driving the same deck at once.
 */
import { forget, forgetAll } from "../deck-context.js";

/** `"9.3"` -> `9`. The one place a node id is taken apart outside `harvest/`. */
const slideOf = (id) => {
  const n = Number(String(id ?? "").split(".")[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Which tools can change wording, and how to find out what they changed.
 *
 * AN ALLOWLIST, so a tool added later invalidates nothing until someone decides what it
 * should invalidate. The failure mode of the inverse -- assume every unknown tool changes
 * everything -- is a re-pin on every navigation, which is the accumulation this whole
 * context module is built to avoid.
 */
const TEXT_TOOLS = new Set(["edit_text", "undo_edits"]);

/**
 * Drop the pins for whatever a tool call just changed.
 *
 * Called only on a SUCCESSFUL edit. A refusal changed nothing, and dropping a pin for it
 * would spend a re-pin to correct the model about something that never happened.
 */
export const invalidate = (name, result) => {
  if (result?.isError || !TEXT_TOOLS.has(name)) return;

  const structured = result?.structuredContent;
  if (!structured?.applied) return;

  // `undo_edits` reports how much went back but not where, so its extent is genuinely
  // unknown from here -- see `forgetAll` in `deck-context.js` for why that is dropped
  // wholesale rather than reconstructed from the edit log's labels.
  if (name === "undo_edits") {
    forgetAll();
    return;
  }

  const slides = new Set();
  // A whole-node rewrite reports `node`; a find-and-replace reports `changed`, which is
  // the one that can span slides -- a deck-wide replace is exactly the case where getting
  // this wrong leaves stale text pinned for every slide but the one on screen.
  if (structured.node?.slide) slides.add(structured.node.slide);
  for (const entry of structured.changed ?? []) {
    const slide = slideOf(entry?.id);
    if (slide) slides.add(slide);
  }

  for (const slide of slides) forget(slide);
};
