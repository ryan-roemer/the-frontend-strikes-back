/**
 * Sized views of the deck, and the rule that picks one.
 *
 * THE BUDGET IS THE DESIGN. Both providers have a real input window around 8-9k tokens,
 * and spending it degrades answers well before filling it (`docs/chat-handoff.md` §6). So
 * the question is never "what could the model know" but "what does THIS request need",
 * measured against the deck's own command families:
 *
 *   "go to slide 10" / "the previous one" / "the last slide"   position    ~20 tok
 *   "summarize this slide"                                     + active     ~90 tok
 *   "change PHRASE_1 to PHRASE_2 on this slide"                + active     ~90 tok
 *   "which slide covers WebMCP"                                + outline   ~370 tok
 *   "every slide that says TODO"                               + index    ~1,700 tok
 *
 * Three of the five need no slide content at all, which is why the default is ~90 tokens.
 *
 * SCOPE IS A SAFETY PROPERTY, not only a budget one. With only the active slide's ids in
 * view, a content command CANNOT address slide 22 -- the blast radius is bounded by
 * construction rather than by the model behaving. Neither provider offers
 * grammar-constrained decoding, so nothing else keeps a 2B model inside the lines.
 *
 * THE VIEW IS CHOSEN IN JS, NEVER BY THE MODEL.
 *
 * WHO CONSUMES WHAT:
 *
 *   WebMCP / `deckDump.context()`  `selectView` + `contextFor`, the per-request cascade
 *                                  above, with node ids for an agent that can act on them.
 *   the chat  `agent/prompt.js` takes `outline`/`outlineText` for the system prompt;
 *             `agent/deck-context.js` pins `slideText(slide, { ids: false })` at most once
 *             per slide. Neither uses the cascade -- they have two fixed sources.
 */
import { getSnapshot } from "../bus.js";
import { asShown } from "../edit/patches.js";
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
 * AN ALIAS, not a wrapper: what this module adds is a vocabulary -- `position`, `outline`,
 * `slideView`, `nodeIndex` are the four sized views, exposed as `deckDump.views` -- not
 * behaviour.
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
 * A SLIDE'S CONTENT IS WHAT IT SAYS, NOT WHAT HAS FADED IN YET. `harvestSlide` reads the
 * fiber tree, so `Appear`-wrapped bullets are present from step 0 -- a question asked
 * before the last bullet animates gets the same answer as one asked after. Animation is
 * pacing for the room, not a fact about the deck.
 *
 * Which makes `step` misleading in the chat's context: handing a model every bullet AND
 * "step 1 of 4" invites it to reason about what the audience can see, from a number that
 * says nothing about which nodes those are. An agent driving the deck needs the step
 * because it can advance it; the chat cannot, so it does not get it.
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
 * The ordinal is added only when the name REPEATS at that depth: "title 1" where there is
 * one title is noise, but without "bullet 2" a phrase like "replace the first bullet" has
 * nothing to attach to and lands on the slide title instead.
 *
 * SHARED with `describeNode`, deliberately -- a confirmation saying "bullet" where the
 * roster said "bullet 2" has the user agreeing to a different thing than will change.
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
 * `ids` IS A FLAG, NOT A SECOND RENDERER. WebMCP needs the `12.3` vocabulary because an
 * agent addresses nodes by it; the chat has no tools, so ids there are ~15% of the block
 * spent on something whose only observable effect is a 2B model reading "12.3" out loud.
 * The day the chat can navigate or edit, this flips back to true and nothing else moves.
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
 * What one slide's nodes are called out loud, WITHOUT their ordinals.
 *
 * `["title", "bullet", "bullet", "bullet", "bullet"]` for a slide of four bullets. The
 * replay harness counts these to find a slide by its shape -- "the slide with four
 * bullets", so that `bullet 4` is addressable and last -- and it has to count the same
 * names `labelOf` hands the model, or a fixture would be describing a vocabulary nothing
 * else uses. Sub-bullets are already a separate name here, which is what makes four
 * bullets and three sub-bullets two groups rather than one of seven.
 */
export const nodeLabels = (nodes) =>
  nodes.map((node) => roleName(node.role, node.depth));

/**
 * A code pane's actual source, fenced.
 *
 * A `CodePane` NODE'S TEXT IS ITS FILENAME -- `code: register-tool.js` -- because that is
 * all `roleOf` can see on the fiber. Without this, a slide whose entire content is a code
 * sample serialises to two lines and the model answers "I can only see the slide title and
 * the file name", on the chapter that is three slides of registration code.
 *
 * The whole deck's source is ~450 tokens, so there is no budget argument for omitting it.
 *
 * Matched by FILE NAME rather than position: the node's text is exactly the key `render()`
 * builds its line from (`file ?? language`), and matching on order would silently pair the
 * wrong source on any slide that grows a second pane.
 */
const codeFence = (slide, node) => {
  const entry = (slide.code ?? []).find(
    (c) => (c.file ?? c.language) === node.text,
  );
  if (!entry?.source) return [];
  return ["```" + (entry.language ?? ""), entry.source, "```"];
};

/**
 * `code` defaults ON, unlike `ids`. The flags look symmetrical and are not: an id is
 * addressing metadata only a caller able to act on it wants, while a code pane's source is
 * the slide's CONTENT -- a view of slide 10 without it is not smaller, it is wrong.
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
 * ~20 tokens instead of the ~65 a slide block costs, for when the deck moves back to a
 * slide already in the conversation. Naming the title as well as the number makes it a
 * REFERENCE rather than a coordinate -- the model has to find the block this points at,
 * and that block was tagged with the title.
 *
 * SPELLED OUT RATHER THAN TERSE, which was measured: the compact form left a 2B model
 * answering about the slide from the previous exchange. Naming the earlier block and
 * stating that the question is about THIS slide is what redirects it. A bad 15 tokens to
 * economise on.
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
 * THE CHEAPEST SAFETY THERE IS. Every way an address goes wrong ends the same way -- the
 * right-looking id for the wrong thing -- and none of them are visible from the id.
 * Quoting the text back makes all of them catchable in one glance.
 *
 * The label comes from the same `labelOf` the roster uses, so the confirmation uses the
 * words the model was offered. It names the SLIDE too, which is the only way to catch the
 * failure that matters most: having resolved against the wrong slide entirely.
 */
export const describeNode = (id, { text } = {}) => {
  const node = resolveNode(id);
  if (!node) return null;

  // NULL RATHER THAN A THROW when the second harvest comes back empty. This runs on the
  // receipt path of every edit, and `apply.js` promises never to throw. The two harvests
  // are separate reads of a live deck -- it can move or unmount between them -- and
  // callers already fall back to the bare id.
  const slide = harvestSlide(node.slide);
  if (!slide) return null;

  const label = labelOf(node, nameCounts(slide.nodes));
  // QUOTED AS THE SLIDE NOW READS IT. The harvest holds the authored wording, so styling
  // a heading that was renamed a turn ago read back `— "TODO: Your next steps (Monday!)"`
  // over a slide saying Tuesday: the one line whose job is to let a person check the
  // address, telling them the tool had landed somewhere it had not.
  //
  // `text` OVERRIDES IT, for the one caller that wants a wording the node no longer has:
  // `apply.js` `setText` reads this back as the BEFORE half of "was → now", and it has
  // the before because it took it off the element a moment earlier. Before this argument
  // existed it relied on the stale harvest to supply that half, which held only for a
  // node's first edit -- a second one reported the ORIGINAL wording as what it replaced.
  const [shown] = asShown([node]);
  return `slide ${node.slide}, ${label} — "${text ?? shown.text}"`;
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

export { outlineText, positionText, slideText };
