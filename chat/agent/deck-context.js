/**
 * Which slide the model has been shown, and what this turn still owes it.
 *
 * The volatile half of deck context. `prompt.js` holds everything that does not
 * change while the deck runs; this holds the one thing that does.
 *
 * THE FAILURE THIS IS SHAPED AROUND. `chat-handoff.md` §6 has the measurement
 * that killed the last attempt: retrieved excerpts sent with every question
 * accumulated inside one conversation and took answers from 5-of-5 usable to
 * 2-of-5, with context climbing 0 -> 1364 -> 1764 -> 2673 -> 4338 tokens. The
 * answers did not degrade gently; they degenerated into "please provide the
 * context."
 *
 * That was not a window problem -- 4,338 of 8,192 is half a window, and the model
 * was already useless. It was a REPETITION problem. Retrieval re-sent overlapping
 * views of the same few slides on every turn, and a 2B model started answering
 * the pile instead of the question.
 *
 * So the rule here is one line: A SLIDE'S TEXT APPEARS AT MOST ONCE PER
 * CONVERSATION. That changes growth from linear in TURNS to linear in DISTINCT
 * SLIDES ASKED ABOUT, and removes near-duplicate blocks entirely.
 *
 * WHY NOT THE `remember` SEAM the handoff docs recommend restoring. `remember`
 * sends context and keeps it out of the transcript -- volatile, send-and-drop.
 * That is precisely the thing that measured badly, and Chrome's durable session
 * cannot do it at any price: whatever is sent is in its history forever. This
 * needs the opposite guarantee -- remember once, never re-send -- so it is a
 * different seam rather than the old one restored. See `providers/index.js`.
 *
 * WHAT BOUNDS IT. Not a cap: the deck. There are 35 slides, so the pinned set has
 * a hard ceiling of 35 blocks whatever anyone types, and a realistic talk asks
 * about five to a dozen (~325-780 tokens). An eviction policy was drafted and
 * dropped -- it would have had to drift from, or be threaded into, each provider's
 * own copy of the pinned messages, and the failure it prevents is a conversation
 * with 25+ distinct slides in it and no press of the broom. Silently dropping
 * content the model has been TOLD it was shown is worse than the growth: it
 * leaves a dangling reference, which is the one failure mode this module exists
 * to prevent.
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
 * DERIVED, NOT CLEARED BY CALLERS. `chat-handoff.md` §6's rule is that anything
 * dropping what the model remembers bumps `epoch` in `model-state.js` -- the
 * broom, freeing the session, deleting the model, switching providers. The pinned
 * set is part of what the model remembers, so it has to follow. Reading the epoch
 * here rather than exporting a `clear()` for six call sites to remember is the
 * same trick `ui/panel.js` uses for the transcript, and for the same reason: the
 * call site that forgets is the one that leaves a dangling reference.
 */
let epoch = null;

const syncEpoch = () => {
  const current = getState().epoch;
  if (current === epoch) return;
  epoch = current;
  pinned.clear();
  lastAsked = null;
};

const NOTHING = { pin: "", note: "" };

/**
 * What this turn owes the model: `{ pin, note }`. Usually both "".
 *
 * TWO FIELDS BECAUSE THEY HAVE DIFFERENT LIFETIMES, and collapsing them into one
 * string was a real bug rather than a tidiness question.
 *
 *   pin   a slide's text. Sent once, KEPT for the rest of the conversation. It is
 *         durable because the model may be asked about that slide again twenty
 *         turns later, and re-sending is the accumulation that measured badly.
 *   note  where the deck is, right now. Sent with THIS question and not kept,
 *         because it is false the moment the deck moves again.
 *
 * The first version put both in the pinned region, and the note being durable was
 * the least of it: the pinned region lives in the PREFACE, so a "the deck moved to
 * slide 9" line sat far above the last exchange rather than next to the question
 * it described. Measured -- asked "remind me what was on this one?" after moving
 * back to slide 9, the model answered about slide 21, the subject of the previous
 * exchange. A per-turn fact has to be adjacent to the turn. The note is therefore
 * prepended to the question by the provider and the pin is not.
 *
 * A PURE READ OF THE CURRENT SNAPSHOT, called at send time. Two consequences
 * worth keeping:
 *
 *   - A slide navigated past and never asked about NEVER ENTERS THE MAP. That is
 *     not a rule implemented anywhere; it is what "read position when a question
 *     is sent" means.
 *   - The rule is AGNOSTIC TO WHO MOVED THE DECK. A slide the presenter walked to
 *     and a slide the assistant navigated to are both simply "not the slide the
 *     last question came from". When the chat can drive navigation itself, step
 *     four of that sequence -- a question about the slide it just moved to --
 *     already works, provided the caller reads after `nav.settle()`.
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
        }
      : NOTHING;
  }

  const slide = slideView(n);
  // `ids: false`: the chat has no tools, so a node id is ~15% of the block spent
  // on something it cannot act on and might read out loud. See `views.js`.
  const body = slideText(slide, { ids: false });
  if (!body) return NOTHING;

  pinned.set(n, { title: slide?.title ?? null, chars: body.length });

  // The position line rides along on a first sighting too: the `<slide n="12">`
  // tag carries the number but not the count, and "how far through are we" is
  // one of the likelier questions to be asked of a deck.
  //
  // `showStep: false` -- the block holds every node on the slide including the
  // ones still waiting to animate in, so a step index would describe a visibility
  // state that nothing else here reflects. See `positionText`.
  return { pin: body, note: positionText(at, { showStep: false }) };
};

/**
 * What has been pinned so far. For the context viewer and `deckDump`.
 *
 * The viewer is the only instrument that can show a presenter what the model is
 * actually holding, so this being accurate is the difference between the panel's
 * `{}` button being a demo and being a lie.
 */
export const pinnedSlides = () => {
  syncEpoch();
  return [...pinned.entries()].map(([slide, { title, chars }]) => ({
    slide,
    title,
    chars,
  }));
};
