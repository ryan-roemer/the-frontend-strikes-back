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
  // `ids: false`: the chat has no tools, so a node id is ~15% of the block spent on
  // something it cannot act on and might read out loud.
  const body = slideText(slide, { ids: false });
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
