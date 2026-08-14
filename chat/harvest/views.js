/**
 * Sized views of the deck, and the rule that picks one.
 *
 * THE BUDGET IS THE DESIGN. Both providers have a real input window around
 * 8-9k tokens (`docs/chat-handoff.md` §8), and §6 there records what happens
 * when you spend it: excerpts accumulating across one conversation took answers
 * from 5-of-5 usable to 2-of-5 while context climbed 0 -> 4,338 tokens. Context
 * is not free and more of it is not better.
 *
 * So the question is never "what could the model know" but "what does THIS
 * request need". Measured against the deck's own command families:
 *
 *   "go to slide 10" / "the previous one" / "the last slide"   position    ~20 tok
 *   "summarize this slide"                                     + active     ~90 tok
 *   "change PHRASE_1 to PHRASE_2 on this slide"                + active     ~90 tok
 *   "which slide covers WebMCP"                                + outline   ~370 tok
 *   "every slide that says TODO"                               + index    ~1,700 tok
 *
 * Three of those five need no slide content at all -- a navigation command is
 * answerable from a slide number and a count. That is why the default here is
 * ~90 tokens rather than the ~745 the handoff doc proposed: it sized the default
 * as facts + outline + active slide, before the command families were written
 * down and it became clear how few of them read the outline.
 *
 * SCOPE IS A SAFETY PROPERTY, not only a budget one. If only the active slide's
 * ids are in view, a content command CANNOT address slide 22 -- the blast radius
 * is bounded by construction rather than by the model behaving. That matters
 * more here than usual, because neither provider offers grammar-constrained
 * decoding (chat-handoff §10), so there is no schema keeping a 2B model inside
 * the lines.
 *
 * THE VIEW IS CHOSEN IN JS, NEVER BY THE MODEL. A deterministic rule costs
 * nothing and cannot hallucinate its way into the wrong scope, which a
 * model-driven selector can and eventually would.
 *
 * NOTHING HERE IS WIRED TO THE MODEL YET. `chat/agent/prompt.js` still says the
 * assistant has no access to the slides, and that stays true until the
 * `remember` seam chat-handoff §6 describes is restored -- the volatile views
 * below must be sent per-turn WITHOUT accumulating in the transcript, and that
 * seam is the only thing that delivers it.
 */
import { getSnapshot } from "../bus.js";
import { harvestDeck, harvestSlide } from "./index.js";

/**
 * Where the deck is, right now.
 *
 * From the bus rather than from a harvest: `chat/bridge.js` publishes
 * `activeView` from inside `DeckContext`, and `getSnapshot()` is a plain
 * function, so this costs nothing and needs no React.
 *
 * `slide` is null when the bridge is unmounted -- overview and presenter mode
 * both swap the whole View subtree out. Callers degrade to the outline rather
 * than guessing, because a confidently wrong "you are on slide 1" is worse than
 * an absent one.
 */
export const position = () => {
  const { ready, activeView, slideCount } = getSnapshot();
  return {
    slide: ready && activeView ? activeView.slideIndex + 1 : null,
    step: ready && activeView ? activeView.stepIndex : null,
    count: slideCount ?? null,
  };
};

/** One line per slide: enough to pick one, not enough to answer from. */
export const outline = () =>
  harvestDeck().slides.map(({ number, chapter, title, kind, code }) => ({
    number,
    chapter,
    title,
    kind,
    code: code.map(({ file, language }) => file ?? language),
  }));

/** One slide's addressable nodes. The view content commands run on. */
export const slideView = (number) => harvestSlide(number);

/**
 * Every addressable node in the deck.
 *
 * The escalation view, for cross-deck find-and-replace and nothing else. At
 * ~1,700 tokens it is a fifth of the window, so `selectView` reaches for it only
 * on an explicit deck-wide phrase.
 */
export const nodeIndex = () =>
  harvestDeck().slides.flatMap((slide) => slide.nodes);

// --- Rendering --------------------------------------------------------------

/**
 * TAG-DELIMITED, following `index.js`'s speaker-notes block and for the same
 * reason: a closing tag is a boundary, whereas finding where a heading-delimited
 * section ENDS means scanning forward for the next heading of the same level,
 * which is a heuristic. Context assembled from several views needs the model to
 * know where each one stops.
 */
const tagged = (tag, lines, attrs = "") =>
  [`<${tag}${attrs}>`, ...lines, `</${tag}>`].join("\n");

const positionText = ({ slide, step, count }) =>
  tagged("deck-position", [
    slide
      ? `slide ${slide} of ${count}${step ? `, step ${step}` : ""}`
      : `${count ?? "?"} slides, current slide unknown`,
  ]);

const outlineText = (slides) =>
  tagged(
    "deck-outline",
    slides.map(({ number, chapter, title, code }) => {
      const tags = [chapter && `ch${chapter}`, ...code].filter(Boolean);
      return `${number} ${title ?? "(untitled)"}${
        tags.length ? ` [${tags.join(", ")}]` : ""
      }`;
    }),
  );

/**
 * A node line: id, what it is, and its text.
 *
 * The role ordinal is only printed when the role REPEATS on that slide. "title
 * 1" where there is one title is noise the model has to read past on every
 * turn, but "bullet 2" is how a presenter names the thing -- and without it,
 * "replace the first bullet" has nothing to attach to. The deleted
 * `deck-adapter.js` recorded that failure: it rewrote a slide title instead.
 */
const nodeLines = (nodes) => {
  const totals = new Map();
  for (const { role } of nodes) totals.set(role, (totals.get(role) ?? 0) + 1);

  return nodes.map(({ id, role, roleOrdinal, text }) => {
    const label = totals.get(role) > 1 ? `${role} ${roleOrdinal}` : role;
    return `${id} ${label}: ${text}`;
  });
};

const slideText = (slide) =>
  slide
    ? tagged(
        "slide",
        nodeLines(slide.nodes),
        ` n="${slide.number}"${slide.chapter ? ` chapter="${slide.chapter}"` : ""}${
          slide.title ? ` title="${slide.title.replace(/"/g, "'")}"` : ""
        }`,
      )
    : "";

const indexText = (nodes) => tagged("deck-nodes", nodeLines(nodes));

// --- Selection --------------------------------------------------------------

/** "slide 10", "slide #10", "10th slide". */
const SLIDE_NUMBER =
  /\bslides?\s*#?\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+slide\b/i;

/** Movement with no destination named. Answerable from position alone. */
const RELATIVE =
  /\b(next|previous|prev|last|first|final|forward|backward|back|ahead|onwards?)\b/i;

/** Explicitly the whole deck. The only thing that unlocks the node index. */
const DECK_WIDE =
  /\b(every|all|each)\s+\w*\s*(slides?|headings?|bullets?|titles?)\b|\b(whole|entire)\s+(deck|talk|presentation)\b|\backross the (deck|talk)\b/i;

/** A slide referred to by what is on it rather than by its number. */
const NAMES_A_SLIDE =
  /\b(slide|section|chapter)\b|\b(go|jump|navigate|skip)\s+to\b/i;

/** The slide on screen, however the user said it. */
const THIS_SLIDE =
  /\b(this|current|the current)\s+(slide|one|page)\b|\bon screen\b|\bhere\b/i;

/**
 * Which views a request needs.
 *
 * An ORDERED CASCADE, most specific first, and each rule exists because a
 * command family needs it:
 *
 *   1. deck-wide     "find every TODO"           the only path to the index
 *   2. a slide by N  "go to slide 10",           that slide's nodes, not the
 *                    "change the title on 10"    active one -- a numbered
 *                                                reference means the user is
 *                                                talking about a slide they may
 *                                                not be standing on
 *   3. relative      "the previous slide"        position only. Nothing about
 *                                                moving one slide back needs to
 *                                                know what is written on it
 *   4. by topic      "the WebMCP slide"          the outline, to resolve a name
 *                                                to a number
 *   5. default       "summarize this slide"      the active slide
 *
 * Rule 2 before rule 3 matters: "go to slide 10" contains no relative word, but
 * "back to slide 10" does, and it is still a numbered destination.
 *
 * Rule 3 before rule 4 matters too: "go to the last slide" says "go to", which
 * rule 4 would read as naming a slide by topic and answer with a 370-token
 * outline the request has no use for.
 */
export const selectView = (text = "") => {
  const said = String(text);

  if (DECK_WIDE.test(said)) return { views: ["position", "index"] };

  const numbered = SLIDE_NUMBER.exec(said);
  if (numbered) {
    return {
      views: ["position", "slide"],
      slide: Number(numbered[1] ?? numbered[2]),
    };
  }

  if (RELATIVE.test(said) && !THIS_SLIDE.test(said)) {
    return { views: ["position"] };
  }

  if (NAMES_A_SLIDE.test(said) && !THIS_SLIDE.test(said)) {
    return { views: ["position", "outline"] };
  }

  return { views: ["position", "slide"] };
};

/**
 * The context for one request, as the string a turn would carry.
 *
 * Returns `chars` alongside so a caller can enforce a budget without
 * re-measuring. Not tokens: this file has no tokenizer and a guessed one that
 * disagrees with the provider's is worse than an honest character count.
 */
export const contextFor = (text) => {
  const selected = selectView(text);
  const at = position();
  const parts = [];

  for (const view of selected.views) {
    if (view === "position") parts.push(positionText(at));
    if (view === "outline") parts.push(outlineText(outline()));
    if (view === "index") parts.push(indexText(nodeIndex()));
    if (view === "slide") {
      // Falls back to the outline when the bridge is down and no slide was
      // named: without a current slide there is no "this slide" to describe,
      // and an empty block reads as "this slide has nothing on it".
      const number = selected.slide ?? at.slide;
      if (number) parts.push(slideText(slideView(number)));
      else parts.push(outlineText(outline()));
    }
  }

  const text_ = parts.filter(Boolean).join("\n\n");
  return {
    views: selected.views,
    slide: selected.slide ?? at.slide,
    text: text_,
    chars: text_.length,
  };
};

export { indexText, outlineText, positionText, slideText };
