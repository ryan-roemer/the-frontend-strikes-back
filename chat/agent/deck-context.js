/**
 * Which slide the model has been shown, and what this turn still owes it.
 *
 * The volatile half of deck context; `prompt.js` holds the half that does not change.
 *
 * ONE RULE: A SLIDE'S TEXT APPEARS AT MOST ONCE PER CONVERSATION. Growth is then linear
 * in DISTINCT SLIDES ASKED ABOUT rather than in turns, with no near-duplicate blocks.
 *
 * That is a repetition constraint, not a window one. Re-sending overlapping views of the
 * same few slides every turn took answers from 5-of-5 usable to 2-of-5 while context
 * climbed to only 4,338 of 8,192 tokens -- half a window, and the model was already
 * answering the pile instead of the question (`chat-handoff.md` §6).
 *
 * BOUNDED BY THE DECK, not by a cap: 35 slides is a hard ceiling of 35 blocks whatever
 * anyone types, and a real talk asks about five to a dozen (~325-780 tokens). Eviction is
 * deliberately absent -- silently dropping content the model has been TOLD it was shown
 * leaves a dangling reference, which is the failure this module exists to prevent.
 */
import { getState } from "./model-state.js";
import { withEdits } from "../edit/patches.js";
import {
  position,
  positionRef,
  positionText,
  slideText,
  slideView,
} from "../harvest/views.js";

/**
 * Slide number -> what was pinned for it. The seen-set and the pinned set are
 * THE SAME STRUCTURE, deliberately: if they could diverge, the divergence would
 * be a "you were shown this already" pointing at content nobody sent.
 */
const pinned = new Map();

/** The slide the previous question was asked from, to spot a deck that moved. */
let lastAsked = null;

/**
 * The `epoch` this state belongs to.
 *
 * DERIVED, NOT CLEARED BY CALLERS. Anything dropping what the model remembers bumps
 * `epoch` in `model-state.js`, and the pinned set is part of what the model remembers.
 * Reading the epoch beats exporting a `clear()` for six call sites to remember -- the one
 * that forgets is the one that leaves a dangling reference. `ui/panel.js` keys the
 * transcript off the same signal.
 */
let epoch = null;

const syncEpoch = () => {
  const current = getState().epoch;
  if (current === epoch) return;
  epoch = current;
  pinned.clear();
  lastAsked = null;
};

const NOTHING = { pin: "", note: "", commit: () => {} };

/**
 * Forget that a slide was ever shown, so the next question re-sends its text.
 *
 * THE EDIT PATH OWES THIS CALL. A slide pinned at turn 2 and changed at turn 5 leaves the
 * model holding the wording the deck no longer has -- and being asked about it, it answers
 * from the pin, confidently, about text the audience can see has changed. That is worse
 * than the dangling reference this module's one rule exists to prevent, because a dangling
 * reference at least reads as a gap.
 *
 * A DROP, NOT AN UPDATE. Re-pinning here would put a second copy of the slide in the
 * preface immediately; dropping means the map no longer claims the model has it, and the
 * next question that lands on that slide sends it once through the ordinary path. Slides
 * nobody asks about again cost nothing.
 *
 * ON CHROME IT IS A PARTIAL FIX AND CANNOT BE MORE. That session owns its own history and
 * has no un-send, so the stale block stays where it is and the fresh one arrives after it.
 * Later text beats earlier text in practice, and the alternative -- a full `create()` at
 * ~9.5s, mid-talk, discarding the transcript -- is not one. On LiteRT the preface is rebuilt
 * from `pinned` every turn, so the drop is complete.
 */
export const forget = (slide) => {
  syncEpoch();
  pinned.delete(Number(slide));
  // `lastAsked` too, when it was that slide: it exists to suppress a repeated position
  // line, and after an edit the next turn should say where the deck is again.
  if (lastAsked === Number(slide)) lastAsked = null;
};

/**
 * Forget every slide, for a change whose extent is not knowable.
 *
 * `undo_edits` is the case, and the only one. Its receipt reports how many edits went back
 * but not which slides they were on -- the labels are prose -- and recovering that by
 * parsing them would be a regex standing between the model and the truth about what it
 * holds. Dropping everything is exact where parsing would be approximate, and the cost is
 * bounded by the same thing that bounds this module: re-pinning is at most one block per
 * distinct slide asked about again, which in a real talk is a handful.
 *
 * NOT AN EPOCH BUMP, which would also be exact and would also wipe the transcript. The
 * model is being corrected about the deck, not restarted, and the exchange above is still
 * true.
 */
export const forgetAll = () => {
  syncEpoch();
  pinned.clear();
  lastAsked = null;
};

/**
 * What this turn owes the model: `{ pin, note }`. Usually both "".
 *
 * TWO FIELDS BECAUSE THEY HAVE DIFFERENT LIFETIMES:
 *
 *   pin   a slide's text. Sent once, KEPT for the rest of the conversation, because the
 *         model may be asked about that slide again twenty turns later.
 *   note  where the deck is, right now. Sent with THIS question and not kept, because it
 *         is false the moment the deck moves again.
 *
 * A PER-TURN FACT MUST BE ADJACENT TO ITS TURN, which is why the note is prepended to the
 * question rather than pinned. In the preface it sits far above the last exchange: asked
 * "remind me what was on this one?" after moving back to slide 9, the model answered about
 * slide 21 -- the subject of the previous exchange.
 *
 * A PURE READ OF THE CURRENT SNAPSHOT, called at send time. So a slide navigated past and
 * never asked about never enters the map, and the rule is agnostic to who moved the deck --
 * provided the caller reads after `nav.settle()`.
 */
export const nextContext = () => {
  syncEpoch();

  const at = position();

  // No confident guess when the bridge is down. Overview and presenter mode both
  // swap out the whole View subtree, and a wrong "you are on slide 1" is worse
  // than no position at all.
  if (!at.slide) return NOTHING;

  const n = at.slide;
  const moved = lastAsked !== n;
  lastAsked = n;

  // Seen before. Either the model is still on the slide it just answered about --
  // in which case saying so again is pure noise -- or the deck moved back to one
  // whose text is already above, which costs a pointer rather than a block.
  if (pinned.has(n)) {
    return moved
      ? {
          pin: "",
          note: positionRef({
            slide: n,
            count: at.count,
            title: pinned.get(n).title,
          }),
          commit: () => {},
        }
      : NOTHING;
  }

  const slide = slideView(n);

  // THROUGH THE EDIT OVERLAY, for the same reason `get_slide` does it: the harvest reads
  // React's fibers and an edit writes the DOM, so a slide read straight from `slideView`
  // reports the wording the deck SHIPPED WITH rather than the wording on screen.
  //
  // This is what makes `forget()` above worth anything. Dropping a pin so the next question
  // re-sends the slide, and then re-sending the authored text, corrects the model with the
  // same stale wording it already had -- the invalidation fires, the block is rebuilt, and
  // nothing about it is new. Measured exactly that way before this line existed.
  //
  // It also covers the edit this module never hears about: a browser extension calling the
  // same registered tools changes the DOM, and any slide pinned afterwards now picks that
  // up even though `invalidate.js` never ran.
  const nodes = withEdits(slide?.nodes ?? []);

  // `ids: false`: a node id is ~15% of the block spent on something the model reads out
  // loud more often than it uses. It CAN act on one now that the tools are wired, but it
  // gets ids from `get_slide` and `find_nodes`, which return them for exactly that -- and
  // those are one call away when a phrase is not enough.
  const body = slideText({ ...slide, nodes }, { ids: false });
  if (!body) return NOTHING;

  // The position line rides along on a first sighting too: the `<slide n="12">` tag
  // carries the number but not the count.
  //
  // `showStep: false` -- the block holds every node on the slide including the ones still
  // waiting to animate in, so a step index would describe a visibility state nothing else
  // here reflects.
  return {
    pin: body,
    note: positionText(at, { showStep: false }),
    /**
     * Record that this slide reached the model. Called by `session.js` on the first chunk.
     *
     * READING THE POSITION MUST NOT PIN IT. A stream that throws before the provider's
     * `prepare()` runs was never sent, and a map claiming otherwise makes the next
     * question on that slide send a bare pointer at content the model does not have --
     * the dangling reference this module exists to prevent. Not committing costs a
     * re-send; committing too early costs a wrong answer.
     */
    commit: () => {
      pinned.set(n, { title: slide?.title ?? null, chars: body.length });
    },
  };
};
