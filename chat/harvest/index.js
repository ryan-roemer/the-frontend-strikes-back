/* global document:false */

/**
 * The whole deck, as data and as one Markdown document.
 *
 * TWO SOURCES, and the split is the same one the deleted `knowledge.js` drew,
 * for the same reason:
 *
 *   1. STRUCTURED, from `chapters.js` and `takeaways.js`. The talk's argument is
 *      kept as data specifically so it cannot drift -- `takeaways.js`: "Edit the
 *      claim here and all three move together" -- which makes those modules the
 *      best deck knowledge available and needs no rendering at all.
 *   2. HARVESTED, from the live React tree. Every slide's headings, bullets,
 *      code and speaker notes, structure intact.
 *
 * Layering is STRUCTURE FIRST. `harvestDeck()` returns objects and
 * `deckMarkdown()` renders them, because the next consumer of this is retrieval
 * and it will want the fields, not a re-parse of prose.
 */
import { DeckContext, Slide } from "spectacle";
import { chapters } from "../../deck/chapters.js";
import { AUDIENCES, PARTS, VERDICTS, takeaways } from "../../deck/takeaways.js";
import { findAll, rootFiber } from "./fiber.js";
import { serializeSlide } from "./markdown.js";
import { elementOf } from "./nodes.js";

/** Slide body headings sit under `## Slide NN`, so they start at `###`. */
const HEADING_BASE = 3;

const chapterOf = (className) => {
  const match = /\bch-(\d)\b/.exec(className ?? "");
  return match ? Number(match[1]) : null;
};

/** The first heading in a slide's body is its title. */
const titleOf = (body) => {
  const match = /^#{1,6}\s+(.*)$/m.exec(body ?? "");
  return match ? match[1].trim() : null;
};

const text = (selector) =>
  document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
  null;

/**
 * Read the deck's own title rather than restating it.
 *
 * `document.title` and the title slide's subtitle are both already authored
 * once. A constant here would be exactly the stale second copy that
 * `chapters.js` and `takeaways.js` exist to prevent.
 */
const deckMeta = (slideCount, source) => ({
  title: document.title || null,
  subtitle: text(".title-subtitle"),
  slides: slideCount,
  source,
  harvested: new Date().toISOString(),
});

/**
 * Every slide, from the fiber tree.
 *
 * Returns null -- not an empty array -- when the tree is unreachable, so the
 * caller can tell "React moved on us" from "this deck has no slides".
 */
/**
 * The deck view a slide belongs to.
 *
 * PRESENTER MODE MOUNTS EVERY SLIDE TWICE -- once for the pane the presenter is
 * reading and once for the next-slide preview -- so a plain `Slide` sweep finds
 * 70 of them and the dump ran to "Slide 70 - Thanks!" with all 35 duplicated.
 * The DOM agrees: `document.querySelectorAll(".slide").length` is 70 there.
 *
 * `Deck` is NOT the discriminator, tempting as it looks: both copies sit under a
 * single exported `Deck` fiber, and the two "Deck"-named fibers that do differ
 * are internal and minified. Each pane does get its own `DeckContext` provider,
 * which is an exported symbol and the same one `chat/bridge.js` reads the deck's
 * navigation state from -- so it is a supported seam rather than a hash.
 */
const deckViewOf = (fiber) => {
  for (let node = fiber; node; node = node.return) {
    if (node.type === DeckContext || node.type === DeckContext?.Provider) {
      return node;
    }
  }
  return null;
};

/**
 * Whether two fibers are the same logical node.
 *
 * REACT DOUBLE-BUFFERS FIBERS. Every node has a `current` fiber and an
 * `alternate`, and a re-render swaps which one is live -- for the subtrees it
 * touched, and only those. So after a navigation some slides' ancestors sit on
 * the new provider fiber and some still point at the old one, even though there
 * is exactly one provider on screen.
 *
 * Comparing by `===` therefore splits ONE pane into two, which is what made the
 * dedup below silently drop slides. Comparing through `alternate` asks the
 * question that was always meant: is this the same component instance.
 */
const sameFiber = (a, b) =>
  !!a && !!b && (a === b || a.alternate === b || b.alternate === a);

/**
 * Every slide of ONE deck view, in slide order.
 *
 * Keeps the first view rather than de-duplicating by content: the copies are
 * identical, so any tie-break is arbitrary, and the first is both the pane the
 * presenter is actually on and a contiguous leading run -- measured [35] in a
 * normal load and [35, 35] in presenter mode.
 *
 * THE `alternate` COMPARISON IS LOAD-BEARING, and its absence was a real bug for
 * as long as this file has existed. It never showed up on a fresh load, because
 * nothing has re-rendered yet and every fiber is on its first copy -- so all the
 * verification this harvest has ever passed ran in the one state where the
 * identity check happens to hold.
 *
 * Measured after three navigations: 35 slides became 33. Slides 2 and 3 dropped
 * out of the deck entirely and every id from 4 up shifted down by two, so
 * `harvestSlide(9)` returned slide 11's content -- under its own name, with a
 * plausible title, reporting success. Nothing threw.
 */
const slideFibers = () => {
  const root = rootFiber();
  if (!root) return [];

  const all = findAll(root, (fiber) => fiber.type === Slide);
  if (all.length < 2) return all;

  const view = deckViewOf(all[0]);
  return view ? all.filter((fiber) => sameFiber(deckViewOf(fiber), view)) : all;
};

/**
 * Whether the fiber harvest can run yet.
 *
 * Cheap on purpose -- it finds the slide fibers without serializing any of
 * them, so `?dump` can poll it every frame while React commits.
 */
export const deckReady = () => slideFibers().length > 0;

/**
 * Give a slide's nodes their addresses.
 *
 * IDS ARE GLOBAL: `9.2` is the second addressable node on slide 9, and it means
 * that everywhere. Per-slide ids (`b2`) would be shorter and would collide the
 * first time two slides' nodes appear in one context -- silently, because both
 * would look valid.
 *
 * `roleOrdinal` is the half that survives contact with a presenter. Nobody says
 * "node 9.3"; they say "the second bullet". The deleted `deck-adapter.js`
 * recorded what its absence costs -- "replace the first bullet" once rewrote a
 * slide TITLE, because three sibling nodes all came back as plain "text" with
 * nothing for "first" to attach to.
 *
 * IT IS SCOPED BY DEPTH AS WELL AS BY ROLE. Emission order is depth-first, so on
 * slide 9 the three sub-bullets are emitted between the third top-level bullet
 * and the fourth. Counting flat per role makes "the fourth bullet" the first
 * SUB-bullet and "the seventh" the one a presenter would call the fourth --
 * numbers that are confidently wrong rather than merely ambiguous. Keyed by
 * `role:depth`, each level counts from one and the count matches the slide.
 */
const addressNodes = (nodes, number) => {
  const seen = new Map();
  return nodes.map((node) => {
    const key = `${node.role}:${node.depth}`;
    const roleOrdinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, roleOrdinal);
    const addressed = {
      id: `${number}.${node.ordinal}`,
      slide: number,
      ordinal: node.ordinal,
      role: node.role,
      depth: node.depth,
      roleOrdinal,
      text: node.text,
    };
    // Non-enumerable, so `?dump` can still `JSON.stringify` a node. See
    // `emitNode`.
    Object.defineProperty(addressed, "fiber", {
      value: node.fiber,
      enumerable: false,
    });
    return addressed;
  });
};

const fiberSlides = () => {
  const fibers = slideFibers();
  if (!fibers.length) return null;

  return fibers.map((fiber, i) => {
    const slide = serializeSlide(fiber, { headingBase: HEADING_BASE });
    return {
      number: i + 1,
      chapter: chapterOf(slide.className),
      kind: slide.kind,
      title: titleOf(slide.body),
      body: slide.body,
      source: slide.source,
      code: slide.code,
      notes: slide.notes,
      nodes: addressNodes(slide.nodes, i + 1),
    };
  });
};

/**
 * One slide, by 1-based number.
 *
 * The cheap path, and the one the active-slide view runs on every navigation:
 * serializing 35 slides to read the 4.3 nodes of the one on screen is most of a
 * harvest's cost for none of its value.
 */
export const harvestSlide = (number) => {
  const fibers = slideFibers();
  const fiber = fibers[number - 1];
  if (!fiber) return null;

  const slide = serializeSlide(fiber, { headingBase: HEADING_BASE });
  return {
    number,
    chapter: chapterOf(slide.className),
    kind: slide.kind,
    title: titleOf(slide.body),
    body: slide.body,
    source: slide.source,
    code: slide.code,
    notes: slide.notes,
    nodes: addressNodes(slide.nodes, number),
  };
};

/**
 * An id -> the node it names, including the live element.
 *
 * RE-WALKS RATHER THAN CACHING, on two counts. React double-buffers fibers
 * through `alternate`, so a fiber held across a commit can be the stale copy of
 * a node that has since re-rendered. And the obvious alternative -- stamping a
 * `data-chat-ref` attribute on the element and querying it later -- is worse:
 * React drops attributes it does not own when it recreates a node, so the
 * address would work right up until the slide re-rendered.
 *
 * EVERY SLIDE'S ELEMENTS EXIST, not just the visible one's. Measured across all
 * 35 slides: 159 of 159 nodes resolve to a connected element carrying the right
 * text. Off-screen slides are laid out at 0x0 rather than unmounted -- Spectacle
 * keeps them in the portal and hides them with transform and overflow -- so a
 * `getBoundingClientRect` of zero means "not on screen", never "not there".
 *
 * Worth knowing before trusting a rect: anything measuring an element to decide
 * whether it is real will conclude that 34 of 35 slides do not exist.
 */
export const resolveNode = (id) => {
  const [slide] = String(id).split(".");
  const node = harvestSlide(Number(slide))?.nodes.find((n) => n.id === id);
  if (!node) return null;

  // Spreading a node drops the non-enumerable fiber, which is the intent
  // everywhere except here -- so it is re-attached the same way rather than
  // assigned. An enumerable one would put a cyclic graph back on a record that
  // `?dump` and every debugging `JSON.stringify` walks.
  const resolved = { ...node, element: elementOf(node.fiber) };
  Object.defineProperty(resolved, "fiber", {
    value: node.fiber,
    enumerable: false,
  });
  return resolved;
};

/**
 * The degraded harvest: visible slide text, from the DOM.
 *
 * Everything the fiber walk exists to avoid is back here -- notes are gone,
 * code panes are Prism spans with a line-number gutter, and headings are
 * indistinguishable from body copy because Spectacle renders both as divs. It
 * is kept because an honest degraded dump beats an empty one, and it is stamped
 * `source: "dom-fallback"` so nobody mistakes one for the other.
 *
 * Reads from a CLONE. `docs/chat-handoff.md` §10 records why nothing here may
 * touch the live tree: removing nodes React's fiber still references can throw
 * `NotFoundError` on the next commit and unmount the root -- a blank deck,
 * mid-talk.
 *
 * Grouped by portal parent for the same reason `slideFibers` groups by deck
 * view: presenter mode mounts all 35 slides twice, and the DOM shows it just as
 * plainly -- 70 `.slide` nodes, in two portals.
 */
const domSlides = () => {
  const all = [...document.querySelectorAll(".slide")];
  const portal = all[0]?.parentElement ?? null;
  const scoped = portal
    ? all.filter((node) => node.parentElement === portal)
    : all;

  return scoped.map((node, i) => {
    const clone = node.cloneNode(true);
    for (const el of clone.querySelectorAll(
      ".code-frame, .prism-code, .react-live-editor, .notes",
    )) {
      el.remove();
    }
    const body = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    const title = text(".slide-title, .title-display, .divider__title");

    return {
      number: i + 1,
      chapter: chapterOf(node.className),
      kind: "dom",
      title,
      body,
      source: null,
      code: [],
      notes: "",
      // Always empty, never absent. Addressing needs component identity and the
      // DOM has none -- but a caller that has to check for the FIELD as well as
      // for its contents will forget, so the degraded harvest keeps the shape.
      nodes: [],
    };
  });
};

/** The deck, structured. */
export const harvestDeck = () => {
  const fromFiber = fiberSlides();
  const slides = fromFiber ?? domSlides();

  return {
    meta: deckMeta(slides.length, fromFiber ? "fiber" : "dom-fallback"),
    parts: Object.values(PARTS).map(({ key, title }) => ({ key, title })),
    chapters: chapters.map(({ n, title }) => ({ n, title })),
    takeaways: takeaways.map(
      ({ n, part, chapter, text: claim, detail, verdict }) => ({
        n,
        part,
        chapter,
        text: claim,
        detail,
        verdict,
      }),
    ),
    audiences: AUDIENCES.map(({ who, claim, action }) => ({
      who,
      claim,
      action,
    })),
    verdicts: Object.entries(VERDICTS).map(([key, { title }]) => ({
      key,
      title,
    })),
    slides,
  };
};

const frontMatter = (meta) =>
  [
    "---",
    ...Object.entries(meta).map(([key, value]) => `${key}: ${value ?? ""}`),
    "---",
  ].join("\n");

/**
 * The argument of the talk, ahead of the slides.
 *
 * First because it is the part that cannot be wrong: it comes from the data
 * modules rather than from a rendering of them.
 */
const facts = (deck) => {
  const lines = ["## Deck facts", "", "### Halves", ""];
  for (const { key, title } of deck.parts)
    lines.push(`* **${key}** — ${title}`);

  lines.push("", "### Chapters", "");
  for (const { n, title } of deck.chapters) lines.push(`${n}. ${title}`);

  lines.push("", "### Takeaways", "");
  for (const { n, chapter, text: claim, detail, verdict } of deck.takeaways) {
    const tags = [`ch${chapter}`, verdict].filter(Boolean).join(", ");
    lines.push(`${n}. **${claim}** *(${tags})*`);
    if (detail) lines.push(`   ${detail}`);
  }

  lines.push("", "### Audiences", "");
  for (const { who, claim, action } of deck.audiences) {
    lines.push(`* **${who}** — ${claim} *Do:* ${action}`);
  }

  lines.push("", "### Verdicts", "");
  for (const { key, title } of deck.verdicts)
    lines.push(`* \`${key}\` — ${title}`);

  return lines.join("\n");
};

/**
 * Drop the one heading that the section heading already says.
 *
 * Every slide leads with its own title, and the section above it is built from
 * that same title, so rendering both printed each of 34 titles twice. Only the
 * FIRST match goes, and only from the rendered copy -- `slide.body` and
 * `slide.source` keep it, because a harvest that quietly edits slide content is
 * not a harvest.
 *
 * Not always the first line: a slide can open with an eyebrow above its title.
 */
const withoutTitleHeading = (body, title) => {
  if (!title) return body;

  let dropped = false;
  return body
    .split("\n")
    .filter((line) => {
      if (dropped) return true;
      const match = /^#{1,6}\s+(.*)$/.exec(line);
      if (!match || match[1].trim() !== title) return true;
      dropped = true;
      return false;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const slideSection = (slide) => {
  const heading = `## Slide ${String(slide.number).padStart(2, "0")}${
    slide.title ? ` — ${slide.title}` : ""
  }`;

  const tags = [
    slide.chapter ? `chapter ${slide.chapter}` : "no chapter",
    slide.kind,
    ...slide.code.map(({ file, language }) => `code: ${file ?? language}`),
  ];

  const body = withoutTitleHeading(slide.body, slide.title);
  const parts = [heading, "", `*${tags.join(" · ")}*`];
  if (body) parts.push("", body);

  // TAGGED, NOT HEADED. Notes carry TODOs and presenter-private asides, so a
  // consumer has to be able to drop them without also losing the slide -- and a
  // `### Speaker notes` heading could not deliver that. Slide bodies emit
  // headings at levels 3 through 6, so the marker sat at the same level as the
  // content it was separating: finding where a note ENDED meant scanning
  // forward for the next heading of level 3 or less, which is a heuristic, not
  // a boundary. A closing tag is a boundary.
  //
  // It is also the shape a model reads as "different KIND of content" rather
  // than "next section", which is the actual distinction here -- these are the
  // presenter's asides, not more slide copy, and they should not come back
  // quoted as fact.
  //
  // The tags sit DIRECTLY against the note, no blank line inside either one.
  // That costs the Markdown reading of the block -- a blank line after the open
  // tag would end the raw-HTML run and let a renderer format the note and hide
  // the tags -- but this document is written to be read as context, where the
  // tighter block is the one that says "this span is the note" without argument.
  if (slide.notes) {
    parts.push("", "<speaker-notes>", slide.notes, "</speaker-notes>");
  }

  return parts.join("\n");
};

/**
 * The deck as one Markdown document.
 *
 * Takes an already-harvested deck when the caller has one, so the `?dump`
 * overlay does not walk all 35 slides twice to show a slide count beside them.
 */
export const deckMarkdown = (harvested) => {
  const deck = harvested ?? harvestDeck();
  const { title, subtitle } = deck.meta;

  return (
    [
      frontMatter(deck.meta),
      "",
      `# ${title ?? "Deck"}`,
      ...(subtitle ? ["", `*${subtitle}*`] : []),
      "",
      facts(deck),
      "",
      // No "## Slides" divider: it would sit at the same level as the 35 slide
      // sections it is meant to introduce, which reads as a 36th slide.
      ...deck.slides.map(slideSection).flatMap((section) => [section, ""]),
    ]
      .join("\n")
      // Section joining leaves runs of blank lines behind wherever a slide had no
      // body or no notes. Safe to flatten: nothing in this deck's code examples
      // carries two consecutive blank lines.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
};
