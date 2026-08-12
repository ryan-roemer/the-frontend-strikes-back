/**
 * What the assistant knows about the talk.
 *
 * Two sources, and the split matters because the model's real input window is
 * about 9,200 tokens -- measured, not the nominal 32k (joyce's note that "session
 * max input is much smaller, like around 9K" checks out exactly).
 *
 *   1. STRUCTURED, from `deck-adapter.js`: the chapters, the six takeaways, the
 *      two audiences, the verdict meanings. ~350 tokens, authoritative, always in
 *      the system prompt. This deck keeps its argument as data specifically so it
 *      cannot drift, which makes it the best knowledge available -- and it means
 *      even a question retrieval misses still gets a defensible answer.
 *
 *   2. HARVESTED, from the live DOM: every slide's visible text. Possible without
 *      navigating anywhere because Spectacle keeps all 35 slides mounted and only
 *      toggles their `display`. Injected as a one-line-per-slide outline (~350
 *      tokens); full text is pulled in per-question by `retrieve.js`.
 *
 * Rejected: fetching and parsing `index.html`. The DOM already holds the rendered
 * result, the markdown slides are built internally by Spectacle so they are not in
 * the source in any usable form, and regexing htm template literals is fragile.
 * Also rejected: a hand-written digest file, which is the exact stale-copy failure
 * `chapters.js` and `takeaways.js` were written to prevent.
 *
 * Known gap: presenter notes are NOT harvestable. Spectacle's `Notes` renders
 * `null` unless a note portal exists, which only happens in presenter mode -- so
 * the speaker's own explanations are invisible here. The takeaways carry the same
 * claims, which is the mitigation.
 */
import {
  AUDIENCE_CARDS,
  CHAPTERS,
  PART_TITLES,
  SKIP_SELECTOR,
  TAKEAWAYS,
  VERDICT_MEANINGS,
  chapterOf,
  slideNodes,
  slideRoot,
} from "../deck-adapter.js";

/** Per-slide text budget. Enough for a dense slide, short of a code pane. */
const MAX_SLIDE_CHARS = 600;
const MAX_TITLE_CHARS = 70;

let cache = null;

/**
 * Drop the harvest.
 *
 * Called after an edit is applied, so the assistant sees its own changes rather
 * than answering from the deck as it was at first question.
 */
export const invalidate = () => {
  cache = null;
};

const clean = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Read one slide.
 *
 * Skipped regions are removed from a CLONE rather than filtered during a walk:
 * `textContent` on the clone then gives the whole slide's prose in document order
 * for free, and code panes -- which are enormous and would swamp the budget --
 * simply are not there.
 */
const harvestSlide = (portalChild, index) => {
  // The deck's own slide element, not react-spring's wrapper around it.
  const slideNode = slideRoot(portalChild);
  const clone = slideNode.cloneNode(true);
  for (const skip of clone.querySelectorAll(SKIP_SELECTOR)) skip.remove();

  // The title is whatever the deck styled as one; falling back to the first
  // non-trivial line keeps every slide addressable, including the markdown sets
  // that carry no explicit title class.
  const titleNode = clone.querySelector(
    ".slide-title, .title-display, .divider__title",
  );
  const body = clean(clone.textContent);
  const title =
    clean(titleNode?.textContent ?? "") || body.slice(0, MAX_TITLE_CHARS);

  return {
    number: index + 1,
    chapter: chapterOf(slideNode),
    title: title.slice(0, MAX_TITLE_CHARS),
    text: body.slice(0, MAX_SLIDE_CHARS),
  };
};

/** Every slide, harvested once and cached until an edit invalidates it. */
export const slides = () => {
  if (cache) return cache;
  const nodes = slideNodes();
  if (!nodes.length) return [];
  cache = nodes.map(harvestSlide);
  return cache;
};

/**
 * The always-present block: what this talk is, as data.
 *
 * Written as terse labelled lines rather than prose or JSON. JSON costs roughly
 * 2.5x the tokens for the same content and invites a small model to answer by
 * echoing the structure back.
 */
export const deckFacts = () => {
  const chapterLines = CHAPTERS.map(({ n, title }) => `  ${n}. ${title}`);

  const takeawayLines = TAKEAWAYS.map(
    ({ n, chapter, text, detail, verdict }) =>
      `  ${n}. [ch${chapter}${verdict ? `, ${verdict}` : ""}] ${text}` +
      (detail ? ` -- ${detail}` : ""),
  );

  const audienceLines = AUDIENCE_CARDS.map(
    ({ who, claim, action }) => `  ${who}: ${claim} Do: ${action}`,
  );

  return [
    "TALK: The Frontend Strikes Back -- WebMCP and the agent-ready browser.",
    `HALVES: ${PART_TITLES.map((p) => `${p.key}=${p.title}`).join(", ")}`,
    "CHAPTERS:",
    ...chapterLines,
    "TAKEAWAYS (the six claims the talk makes):",
    ...takeawayLines,
    `VERDICTS: ${VERDICT_MEANINGS.map((v) => `${v.key}=${v.title}`).join("; ")}`,
    "AUDIENCES:",
    ...audienceLines,
  ].join("\n");
};

/** One line per slide: number, chapter, title. The map of the whole deck. */
export const outline = () =>
  slides()
    .map(
      ({ number, chapter, title }) =>
        `${String(number).padStart(2, "0")} ${chapter ? `[ch${chapter}]` : "[--]"} ${title}`,
    )
    .join("\n");
