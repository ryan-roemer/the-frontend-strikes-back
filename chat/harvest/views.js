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
 * WHO CONSUMES WHAT. Three callers, taking opposite halves -- `chat/agent/prompt.js`
 * takes `outline` and `outlineText` for the system prompt, and the two below:
 *
 *   WebMCP / `deckDump.context()`  `selectView` + `contextFor` -- the per-request
 *                                  cascade above, with node ids, for an agent
 *                                  that can act on them.
 *   the chat  `chat/agent/deck-context.js` -- `outlineText` once in the system
 *             prompt, and `slideText(slide, { ids: false })` pinned at most once
 *             per slide. It does NOT use the cascade: it has two fixed sources,
 *             and routing between five views per question is the complexity that
 *             sank the last attempt.
 *
 * The cascade stays regardless. It is the seam for the chat driving navigation
 * itself, which is the next thing after this one.
 */
import { getSnapshot } from "../bus.js";
import { harvestDeck, harvestSlide, resolveNode } from "./index.js";

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

/**
 * One slide's addressable nodes. The view content commands run on.
 *
 * AN ALIAS, not a wrapper. It was `(number) => harvestSlide(number)`, which reads as
 * though it might one day do something. It does not and should not: what this module adds
 * is a vocabulary -- `position`, `outline`, `slideView`, `nodeIndex` are the four sized
 * views, and `dump.js` exposes exactly those as `deckDump.views` -- not behaviour.
 */
export const slideView = harvestSlide;

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

/**
 * `step` is reported to an agent and withheld from the chat, which is not an
 * inconsistency but the same rule applied twice.
 *
 * A SLIDE'S CONTENT IS WHAT IT SAYS, NOT WHAT HAS FADED IN YET. `harvestSlide`
 * reads the fiber tree, so `Appear`-wrapped bullets are present from step 0 --
 * measured identical before and after stepping through slide 3 -- and that is the
 * behaviour we want: a question asked before the last bullet animates should get
 * the same answer as one asked after. Animation is pacing for the room, not a
 * fact about the deck.
 *
 * Which makes `step` actively misleading in the chat's context. Handing a model
 * every bullet AND "step 1 of 4" invites it to reason about what the audience can
 * currently see, from a number that says nothing about which nodes those are. An
 * agent driving the deck genuinely needs the step, because it has to be able to
 * advance it; the chat cannot, so it does not get it.
 */
const positionText = ({ slide, step, count }, { showStep = true } = {}) =>
  tagged("deck-position", [
    slide
      ? `slide ${slide} of ${count}${showStep && step ? `, step ${step}` : ""}`
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
 * A bullet nested inside another one is a "sub-bullet" to everybody except the
 * fiber tree, where both are a `ListItem`. The ROLE stays `bullet` so the
 * vocabulary does not fork -- only what it is called out loud changes.
 */
const roleName = (role, depth) =>
  role === "bullet" && depth > 1 ? "sub-bullet" : role;

/**
 * How many nodes on this slide share a name, so the caller knows whether the
 * ordinal is needed to tell them apart.
 *
 * Keyed by the SPOKEN name and the depth, matching how `addressNodes` counts:
 * four bullets and three sub-bullets are two groups of siblings, not one group
 * of seven.
 */
const nameCounts = (nodes) => {
  const totals = new Map();
  for (const { role, depth } of nodes) {
    const key = `${roleName(role, depth)}:${depth}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return totals;
};

/**
 * What to call one node, out loud.
 *
 * The ordinal is only added when the name REPEATS at that depth. "title 1" where
 * there is one title is noise the model reads past on every turn, but "bullet 2"
 * is how a presenter names the thing -- and without it "replace the first bullet"
 * has nothing to attach to. The deleted `deck-adapter.js` recorded that failure:
 * it rewrote a slide title instead.
 *
 * SHARED with `describeNode`, deliberately. A confirmation that says "bullet"
 * where the roster said "bullet 2" is worse than no confirmation, because the
 * user agrees to a different thing than the one that will change.
 */
const labelOf = (node, totals) => {
  const name = roleName(node.role, node.depth);
  return totals.get(`${name}:${node.depth}`) > 1
    ? `${name} ${node.roleOrdinal}`
    : name;
};

/**
 * A node line: optionally its id, what it is, and its text.
 *
 * Indented by list depth, which costs two spaces and tells the model that three
 * of slide 9's bullets sit under the one above them. Without it the roster reads
 * as seven siblings and "the last bullet" picks the wrong one.
 *
 * `ids` IS A FLAG, NOT A SECOND RENDERER. The WebMCP layer needs the `12.3`
 * vocabulary because an agent addresses nodes by it; the chat does not, because
 * it has no tools and cannot act on an id -- so ids there are ~15% of the block
 * spent on something whose only observable effect would be a 2B model reading
 * "12.3" out loud. The day the chat can navigate or edit, this flips back to
 * true and nothing else moves. Same reasoning `provenance` is kept out of model
 * context in `deck-context-handoff.md` §5.
 */
const nodeLine = (node, totals, { ids }) => {
  const indent = "  ".repeat(Math.max(0, node.depth - 1));
  const label = `${indent}${labelOf(node, totals)}: ${node.text}`;
  return ids ? `${node.id} ${label}` : label;
};

const nodeLines = (nodes, { ids = true } = {}) => {
  const totals = nameCounts(nodes);
  return nodes.map((node) => nodeLine(node, totals, { ids }));
};

/**
 * A code pane's actual source, fenced.
 *
 * A `CodePane` node's TEXT IS ITS FILENAME -- `code: register-tool.js` -- because
 * that is what `roleOf` can see on the fiber. Which meant a slide whose entire
 * content is a code sample serialised to two lines, and the assistant, asked to
 * explain the code, correctly and uselessly answered "I cannot see the actual
 * code within register-tool.js. I can only see the slide title and the file name."
 * On a talk whose first chapter is three slides of WebMCP registration code, that
 * is the single worst place to be blind.
 *
 * The source is right there on `slide.code[]` and always has been; nothing was
 * reading it. Whole deck: three slides, 1,815 characters, ~450 tokens for ALL of
 * it, so there is no budget argument for leaving it out -- one code slide's block
 * goes from ~40 characters to ~620, still under 160 tokens.
 *
 * Matched by FILE NAME rather than by position, because the node's text is
 * exactly the key `render()` builds its line from (`file ?? language`), and
 * matching on order would silently pair the wrong source on any slide that ever
 * grows a second pane.
 */
const codeFence = (slide, node) => {
  const entry = (slide.code ?? []).find(
    (c) => (c.file ?? c.language) === node.text,
  );
  if (!entry?.source) return [];
  return ["```" + (entry.language ?? ""), entry.source, "```"];
};

/**
 * `code` defaults ON, unlike `ids`.
 *
 * The two flags look symmetrical and are not. An id is addressing metadata that
 * only a caller able to act on it wants; the source of a code pane is the slide's
 * CONTENT, and a view of slide 10 without it is not a smaller view of slide 10,
 * it is a wrong one. So the only caller who should turn this off is one that has
 * measured that it cannot afford it, and none currently do.
 */
const slideText = (slide, { ids = true, code = true } = {}) => {
  if (!slide) return "";
  const totals = nameCounts(slide.nodes);
  const lines = slide.nodes.flatMap((node) => {
    const line = nodeLine(node, totals, { ids });
    return code && node.role === "code"
      ? [line, ...codeFence(slide, node)]
      : [line];
  });
  return tagged(
    "slide",
    lines,
    ` n="${slide.number}"${slide.chapter ? ` chapter="${slide.chapter}"` : ""}${
      slide.title ? ` title="${slide.title.replace(/"/g, "'")}"` : ""
    }`,
  );
};

const indexText = (nodes) => tagged("deck-nodes", nodeLines(nodes));

/**
 * "You are here, and you have seen this one already."
 *
 * The cheap half of the chat's per-turn context: ~20 tokens instead of the ~65 a
 * slide block costs, for the case where the deck has moved back to a slide whose
 * content is already in the conversation. Naming the title as well as the number
 * is what makes it a REFERENCE rather than a bare coordinate -- the model has to
 * be able to find the block this points at, and it was tagged with that title.
 *
 * SPELLED OUT RATHER THAN TERSE, and that was measured. "Now on slide 9 of 35
 * ("How WebMCP works"), already shown above" left a 2B model answering about the
 * slide from the previous exchange instead. Naming the earlier block explicitly,
 * and saying that the question is about this slide, is what actually redirects it
 * -- 15 tokens is a bad place to economise.
 */
export const positionRef = ({ slide, count, title }) =>
  tagged("deck-position", [
    `The deck has moved to slide ${slide}${count ? ` of ${count}` : ""}${
      title ? `: "${title.replace(/"/g, "'")}"` : ""
    }.`,
    `Its content was given earlier in this conversation, in the block tagged n="${slide}".`,
    "The question below is about THIS slide, not the one discussed in the previous exchange.",
  ]);

/**
 * One node, as the sentence you would read back before changing it.
 *
 *   slide 9, bullet 2 -- "One API: document.modelContext"
 *
 * THE CHEAPEST SAFETY THERE IS. Every way an address can go wrong here ends the
 * same way -- the right-looking id for the wrong thing -- and none of them are
 * visible from the id. Resolving it and quoting the text back turns all of them
 * into something the user can catch in one glance, for the cost of one lookup.
 *
 * The label comes from the same `labelOf` the roster uses, so the words in the
 * confirmation are the words the model was offered.
 *
 * Names the SLIDE as well as the node, because the id already encodes it and a
 * confirmation that omits it cannot catch the one failure that matters most:
 * having resolved against the wrong slide entirely.
 */
export const describeNode = (id) => {
  const node = resolveNode(id);
  if (!node) return null;

  // NULL RATHER THAN A THROW when the second harvest comes back empty. This runs on
  // the receipt path of every edit, inside `chat/edit/apply.js`, whose header promises
  // "Never throws. A bad op is a message, not a crash." The two harvests are separate
  // reads of a live deck: the first can succeed and the deck can move or unmount
  // before the second, and `slide.nodes` on a null slide took the whole edit down as a
  // transport failure. Callers already fall back to the bare id.
  const slide = harvestSlide(node.slide);
  if (!slide) return null;

  const label = labelOf(node, nameCounts(slide.nodes));
  return `slide ${node.slide}, ${label} — "${node.text}"`;
};

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

// `indexText`, `labelOf`, `nameCounts` and `roleName` were exported here too and had
// no consumer outside this file. They are still used inside it -- `describeNode` and
// the roster builders -- just no longer part of the module's surface.
export { outlineText, positionText, slideText };
