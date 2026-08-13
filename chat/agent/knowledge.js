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
  CODE_SELECTOR,
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

/**
 * Per-pane code budget.
 *
 * Measured: the deck has four panes, on slides 9-12, of 607-706 characters each, 1,949 in
 * total. So 800 holds every one of them whole -- this is a guard against a pane being added
 * later that is far longer, not a trim of what is there now.
 *
 * Code is deliberately NOT part of `text`. The retrieval bag and the per-slide budget are
 * both sized for prose, and folding 700 characters of JavaScript into a 600-character field
 * would push the actual slide content out of it.
 */
const MAX_CODE_CHARS = 800;

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
 * The code panes on one slide, as code rather than as a wall of characters.
 *
 * Three things have to be undone to get usable source back out of a rendered pane:
 *
 *   - The FILENAME lives in `.code-frame__name` inside the frame, so a plain `textContent`
 *     read returns "register-tool.js" glued to the first line of code.
 *   - Prism renders the GUTTER as `.linenumber` spans inside the `<code>` element, so the
 *     same read interleaves line numbers with the source: "1document.modelContext...".
 *     They are removed from a clone, which leaves the newlines that separate rows intact.
 *   - The LANGUAGE is only knowable from Prism's `language-*` class.
 *
 * Whitespace is preserved rather than collapsed, unlike prose: indentation is most of what
 * makes code readable, and the model is being asked about structure.
 */
const harvestCode = (node) => {
  const panes = [];
  for (const frame of node.querySelectorAll(CODE_SELECTOR)) {
    // Outermost frames only, or a `.prism-code` nested in a `.code-frame` reports twice.
    if (frame.parentElement?.closest(CODE_SELECTOR)) continue;

    const name = clean(
      frame.querySelector(".code-frame__name")?.textContent ?? "",
    );
    const codeEl = frame.querySelector("code") ?? frame;
    const language = [...codeEl.classList]
      .find((cls) => cls.startsWith("language-"))
      ?.slice("language-".length);

    const copy = codeEl.cloneNode(true);
    for (const gutter of copy.querySelectorAll(".linenumber")) gutter.remove();
    const text = (copy.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;

    panes.push({
      name: name || null,
      language: language || null,
      text: text.slice(0, MAX_CODE_CHARS),
    });
  }
  return panes;
};

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

  // BEFORE the skipped regions are removed -- code panes are among them, and this is the
  // only chance to read them.
  const code = harvestCode(clone);

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
    code,
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

/**
 * One line per slide: number, chapter, title. The map of the whole deck.
 *
 * Slides carrying code are marked, and the marker names the FILE rather than just saying
 * "code" -- "register-tool.js" is what someone asking about it will actually say, so it
 * gives retrieval a term to match on and the model a way to answer "which slide shows the
 * tool handler". It costs a few characters on four of thirty-five lines; the code itself
 * stays out of here and arrives through per-turn retrieval.
 */
export const outline = () =>
  slides()
    .map(({ number, chapter, title, code }) => {
      const files = (code ?? [])
        .map((pane) => pane.name || pane.language)
        .filter(Boolean)
        .join(", ");
      return (
        `${String(number).padStart(2, "0")} ${chapter ? `[ch${chapter}]` : "[--]"} ${title}` +
        (files ? ` +code: ${files}` : "")
      );
    })
    .join("\n");
