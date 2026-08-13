/* global DOMException:false, console:false */
import { CHAPTERS, chapterOf, slideNodes } from "../deck-adapter.js";
import { getSnapshot } from "../bus.js";
import { build, serialize } from "../edit/inventory.js";
import { apply } from "../edit/apply.js";
import { summary as editSummary } from "../edit/patches.js";
import { ROUTE_SCHEMA, opSchema } from "./schema.js";
import { decode } from "./planner.js";
import { streamAnswer } from "./session.js";

/**
 * One turn: decide what the presenter meant, then either answer or change the deck.
 *
 *   route  -- constrained, ephemeral session, ~5 tokens out of an enum of nine
 *   answer -- durable session, streamed, unconstrained          (the Q&A path)
 *   fill   -- constrained, ephemeral session, live enums        (the edit path)
 *
 * The two paths are genuinely different and it is worth keeping them apart. Prose
 * has to stream and must not be truncated by a schema; an op has to be exact and
 * must not be prose. A single prompt that tried to do both would do neither well on
 * a 3B model.
 */

const aborted = () => new DOMException("Aborted", "AbortError");

const chapterTitle = (n) => CHAPTERS.find((c) => c.n === n)?.title;

/** What is on screen right now, as a few lines of prompt. */
const situation = () => {
  const { activeView, slideCount } = getSnapshot();
  const slideIndex = activeView?.slideIndex ?? 0;
  const inventory = build();
  const chapter = chapterOf(slideNodes()[slideIndex]);
  return {
    inventory,
    chapter,
    slideIndex,
    text: serialize(inventory, {
      chapter,
      chapterTitle: chapterTitle(chapter),
    }),
    slideCount: slideCount || 35,
  };
};

/**
 * What the last edit touched, so a follow-up has something to refer to.
 *
 * "change the subtitle to pink" then "now red" is the natural way to speak, and the second
 * instruction names nothing at all. Without this it routed to `set_var` and recoloured the
 * whole deck -- and that got MORE likely once the router was taught that naming an element
 * means `set_style`, because "now red" names none.
 *
 * A module-level single slot rather than anything cleverer: it only ever answers "what does
 * 'it' mean", and 'it' is the thing just changed.
 */
let lastTarget = null;

/**
 * The remembered target, but only where it still means something.
 *
 * A ref is an index into ONE slide's inventory, so `e3` after navigating is a different
 * element entirely -- silently recolouring it would be the worst kind of wrong. Guarded on
 * both the slide index and the ref still being present in the current inventory, which also
 * covers the slide being re-harvested underneath us.
 */
const carriedTarget = (context) => {
  if (!lastTarget) return null;
  if (lastTarget.slideIndex !== context.slideIndex) return null;
  if (!context.inventory.refs.includes(lastTarget.ref)) return null;
  return lastTarget;
};

/** One line naming the thing a bare follow-up should attach to. */
const followUpLine = (context) => {
  const target = carriedTarget(context);
  if (!target) return "";
  const entry = context.inventory.entries.find((e) => e.ref === target.ref);
  const role = entry ? ` (the ${entry.role})` : "";
  return (
    `LAST CHANGE: ${target.label} — element ${target.ref}${role}. ` +
    `If this instruction names nothing and continues that thought ("now red", ` +
    `"bigger", "a bit more"), it means ${target.ref}.`
  );
};

/**
 * Does this instruction name anything on the slide?
 *
 * Deliberately crude -- a ref id, or any harvested element's role word. It only has to
 * distinguish "the subtitle should be red" from "now red", and getting that wrong in the
 * cautious direction (deciding an instruction DOES name something) simply leaves the model
 * to work it out, which is the behaviour without any of this.
 */
const namesAnElement = (text, context) => {
  const lower = text.toLowerCase();
  if (
    context.inventory.refs.some((ref) => new RegExp(`\\b${ref}\\b`).test(lower))
  ) {
    return true;
  }
  return context.inventory.entries.some(
    (entry) => entry.role && lower.includes(entry.role.toLowerCase()),
  );
};

/**
 * Words a presenter uses for a thing on a slide, mapped to the role kinds it could mean.
 *
 * "bullet" is the load-bearing entry: the deck's intro bullets are `<div>`s, so their role is
 * "text N" and nothing connects the two without this.
 */
const NOUN_KINDS = {
  bullet: ["text", "bullet"],
  bullets: ["text", "bullet"],
  line: ["text", "bullet"],
  item: ["text", "bullet", "roadmap item"],
  point: ["text", "bullet"],
  paragraph: ["text"],
  title: ["title", "chapter title"],
  heading: ["title", "chapter title"],
  subtitle: ["subtitle"],
  eyebrow: ["eyebrow"],
  row: ["matrix row"],
  note: ["matrix note", "takeaway detail"],
  takeaway: ["takeaway"],
  card: ["card label"],
  url: ["demo url"],
  link: ["demo url"],
};

const ORDINALS = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
};

/** The kind half of a role, with any trailing position stripped: "matrix row 3" -> "matrix row". */
const kindOfRole = (role) => String(role).replace(/\s+\d+$/, "");

/**
 * Which element does a phrase like "the first bullet" or "the title" mean?
 *
 * Resolved HERE rather than by the model, for the same reason as the follow-up referent: it is
 * a deterministic lookup against a list we already have, and the model measurably could not do
 * it. Asked to "replace the first bullet with \"one\"" it returned
 * `{"ref":"e5","text":"I've been building for the web a long time..."}` -- the wrong element
 * AND its existing wording copied back. Given an explicit ref ("change e2 text to \"one\"") it
 * was correct every time. So the failure is entirely in resolving the phrase, and that is the
 * part worth taking away from it.
 *
 * Returns null unless it is confident: no ordinal and no noun match means say nothing and let
 * the model decide, which is exactly the behaviour without any of this.
 */
const resolveNamedTarget = (text, context) => {
  const lower = text.toLowerCase();
  const entries = context.inventory.entries;

  const noun = Object.keys(NOUN_KINDS).find((word) =>
    new RegExp(`\\b${word}\\b`).test(lower),
  );
  const ordinalWord = Object.keys(ORDINALS).find((word) =>
    new RegExp(`\\b${word}\\b`).test(lower),
  );
  if (!noun && !ordinalWord) return null;

  const kinds = noun ? NOUN_KINDS[noun] : null;
  const candidates = kinds
    ? entries.filter((entry) => kinds.includes(kindOfRole(entry.role)))
    : // An ordinal with no noun ("make the second one bigger") means the numbered things,
      // which are never the title.
      entries.filter(
        (entry) =>
          !["title", "subtitle", "eyebrow"].includes(kindOfRole(entry.role)),
      );
  if (!candidates.length) return null;

  if (ordinalWord) {
    const wanted = ORDINALS[ordinalWord];
    // Match the POSITION baked into the role rather than indexing the filtered list. The two
    // usually agree, but a nested element can share a kind with its own parent -- the intro
    // slide's second bullet contains a link, so "text 2" occurs twice -- and positional roles
    // survive that where an array index does not.
    const exact = candidates.find((entry) =>
      new RegExp(`\\s${wanted}$`).test(entry.role),
    );
    return exact ?? candidates[wanted - 1] ?? null;
  }
  // A noun with no ordinal is only unambiguous when there is exactly one of them.
  return candidates.length === 1 ? candidates[0] : null;
};

/**
 * Resolve "it" before the model ever sees the instruction.
 *
 * A system-prompt aside asking the model to apply a conditional rule was measured NOT to
 * work: "now red" kept routing to `set_var` and recolouring the whole deck even with the
 * antecedent spelled out above the op list. Pronoun resolution against "the thing just
 * changed" is deterministic anyway, so it belongs in code, and the resolved referent belongs
 * in the INSTRUCTION where a small model actually attends to it.
 *
 * Only when the instruction names nothing itself -- an explicit target always wins over a
 * remembered one, or "now make the TITLE red" would keep hitting the subtitle.
 */
const resolveReferent = (text, context) => {
  // A phrase naming something on THIS slide wins over anything remembered: "now make the
  // title red" must not keep hitting whatever was changed last.
  const named = resolveNamedTarget(text, context);
  if (named) {
    return (
      `INSTRUCTION: ${text}\n` +
      `(“${named.role}” on this slide is element ${named.ref}. Use that ref.)`
    );
  }

  const target = carriedTarget(context);
  if (!target || namesAnElement(text, context)) return `INSTRUCTION: ${text}`;
  const entry = context.inventory.entries.find((e) => e.ref === target.ref);
  const role = entry?.role ? `the ${entry.role}, ` : "";
  return (
    `INSTRUCTION: ${text}\n` +
    `(This continues the previous change. "it" means ${role}element ${target.ref}.)`
  );
};

/**
 * The recent-edits digest.
 *
 * Cheaper than syncing edits into the durable session, and it means the planner
 * knows what it already did without a round trip. Last three is enough for "make it
 * bigger still" to make sense.
 */
const recentEdits = () => {
  const { labels } = editSummary();
  if (!labels.length) return "";
  return `RECENT EDITS (newest last): ${labels.slice(-3).join(" | ")}`;
};

/**
 * `set_style` and `set_var` are the pair that gets confused, and it is worth knowing why.
 *
 * Both change colours, so a description that says "colour" in both lines gives a 2B model
 * nothing to choose on. "Change subtitle to pink" routed to `set_var`, whose fill pass then
 * tried to use an element ref as a CSS variable name, and the presenter was told "This slide
 * isn't inside a chapter." -- a third-order symptom of a first-order routing mistake.
 *
 * So the distinction is drawn on SCOPE rather than on property: naming something on the slide
 * decides it. That is a question the model can actually answer from the instruction alone.
 */
const ROUTE_SYSTEM = [
  "You classify one instruction from someone presenting a slide deck.",
  "Choose exactly one op:",
  "- answer: they asked a question, or want information. THE DEFAULT.",
  "- set_text: change the WORDS of one element.",
  "- set_style: change how ONE ELEMENT looks — its size, colour, weight or spacing." +
    " THE DEFAULT for any appearance change. Choose it when the instruction names" +
    " something on the slide, AND when it names nothing at all: a bare follow-up" +
    ' like "now red" or "make it bigger" continues the previous change.',
  "- set_var: change a colour across the WHOLE DECK or a whole chapter. ONLY when the" +
    ' instruction says so in as many words — "the deck", "every slide", "the whole' +
    ' talk", "this chapter". If it does not say that, it is not set_var.',
  "- toggle_class: apply or remove a named style class.",
  "- goto: move to another slide or chapter.",
  "- deck_action: fullscreen, or change the heading treatment.",
  "- undo: reverse the last change.",
  "- reset: reverse every change.",
  "If it is not clearly an instruction to change or move something, choose answer.",
].join("\n");

/**
 * Per-op guidance for the fill pass.
 *
 * This did not exist while the Prompt API's `responseConstraint` was doing the work, and it
 * has to now. But note WHY, because it is not simply "the constraint is gone": a constraint
 * only ever stopped values that were outside the schema. It could never have stopped the
 * failure actually observed here -- "Go to slide 12" decoding as `where: "prevSlide"`, which
 * is a perfectly valid enum member and the wrong answer. No grammar catches that. Only the
 * prompt can.
 *
 * Kept to one line per op deliberately. The fill preface is rebuilt every turn and prefill is
 * ~2000 tokens/sec, so this is nearly free, but it is still context competing with the element
 * table that the refs depend on.
 */
const FILL_HINTS = {
  // "replace first bullet with \"one\"" produced a rewrite of the entire slide instead of the
  // word "one". When the instruction quotes the replacement it is not asking for authorship,
  // and saying so is the difference between an edit and an invention.
  set_text:
    'If the instruction quotes the new text, use it EXACTLY and nothing else — "one" means' +
    " the text becomes one. Otherwise rewrite only the wording of that one element, short" +
    " enough to fit the slide. Never copy in text from elsewhere on the slide.",
  set_style:
    "Pick the one CSS property that matches the request: size means font-size, " +
    "colour means color, bolder means font-weight. The value must be REAL CSS: use " +
    '"larger" or "smaller" for bigger/smaller, a length like 2rem, or a colour name ' +
    'or hex. Never "bigger".',
  set_var:
    '"name" must be one of the CSS variables listed in the schema — never an element' +
    ' id. Use scope "deck" unless the instruction explicitly says "this chapter".' +
    " If you wanted to colour one element, this is the wrong op.",
  toggle_class:
    'Set "on" to true to apply the class and false to remove it. "stop", "undo" ' +
    'and "less" mean false.',
  goto:
    'A specific number means where "slide" plus that slideIndex. A named chapter means ' +
    'where "chapter". Only use "next"/"prev"/"nextSlide"/"prevSlide" when the ' +
    "instruction says nothing about which slide.",
  deck_action:
    "fullscreen toggles fullscreen; heading_style changes the heading treatment.",
};

const fillSystem = (op, context) =>
  [
    `You are filling in the details of a "${op}" instruction for a slide deck.`,
    "Use ONLY the element ids listed below. Reply with the fields the schema asks for.",
    // Said outright, because the listing is the most JSON-shaped thing in the prompt and the
    // model reached for it: it answered by copying an element's CURRENT wording into `text`.
    "The list below is what the slide says NOW. It is context, not an answer — never copy a" +
      " line out of it unless the instruction asks you to keep that wording.",
    FILL_HINTS[op],
    "",
    context.text,
    followUpLine(context),
    recentEdits(),
  ]
    .filter(Boolean)
    .join("\n");

/**
 * Route, then act.
 *
 * Shaped as the `respond` contract `useConversation` expects, so the panel does not
 * know or care which path a turn took.
 */
export const respond = async ({ text, onChunk, signal }) => {
  const context = situation();

  let route;
  try {
    route = await decode({
      // The router needs the follow-up context too, not just the fill pass. A bare
      // "now red" is exactly the case where it has to know that something was just
      // recoloured -- otherwise "names no element" sends it to `set_var` and the
      // whole deck changes colour.
      system: [ROUTE_SYSTEM, followUpLine(context)].filter(Boolean).join("\n"),
      message: resolveReferent(text, context),
      schema: ROUTE_SCHEMA,
      label: "route",
      // Without this the stop button did nothing while the router was thinking:
      // the turn ran to completion and only noticed the abort afterwards.
      signal,
    });
  } catch (err) {
    // An abort is the user's decision and must propagate, not be swallowed by the
    // fall-back-to-answering path below.
    if (err.name === "AbortError" || signal?.aborted) throw err;
    // Routing is an optimisation, not a gate. If the classifier fails -- timeout,
    // an unavailable model, a Chrome error -- answering is the safe default: it
    // cannot damage the deck, and the answer path reports its own errors properly.
    return streamAnswer({ text, onChunk, signal });
  }

  // Aborted between passes: stop here rather than starting an answer nobody is
  // waiting for. (This used to hand off to `streamAnswer`, which then had to notice
  // the same abort all over again.)
  if (signal?.aborted) throw aborted();

  const op = route?.op ?? "answer";
  if (op === "answer") return streamAnswer({ text, onChunk, signal });

  // Ops with no fields skip the fill pass; asking a model to produce `{}` invites it
  // to produce something else.
  if (op === "undo" || op === "reset") {
    // The thing "it" referred to has just been un-done, so stop offering it as the
    // antecedent -- "now red" straight after an undo should not silently re-target
    // the element whose change was just reverted.
    lastTarget = null;
    return receipt(apply({ op }));
  }

  let filled;
  try {
    filled = await decode({
      system: fillSystem(op, context),
      message: resolveReferent(text, context),
      schema: opSchema({
        refs: context.inventory.refs,
        slideCount: context.slideCount,
        // The title slide belongs to no chapter, so chapter scope is not offered there.
        hasChapter: context.chapter != null,
      })[op],
      label: op,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    // What the presenter can do about it, not what went wrong inside. "the reply contained
    // no JSON object" is true, unactionable, and about our plumbing rather than their deck;
    // naming an element is the thing that actually rescues one of these.
    return {
      text:
        `I understood that as “${op.replace(/_/g, " ")}” but couldn't work out the ` +
        "details. Try naming the element — for example “change the title to …”.",
    };
  }

  // The instruction's own words win over the model's paraphrase of them.
  if (op === "set_text") {
    const quoted = quotedReplacement(text);
    if (quoted && filled.text !== quoted) {
      console.debug(
        `[chat] using the quoted replacement ${JSON.stringify(quoted)} over ${JSON.stringify(filled.text)}`,
      );
      filled = { ...filled, text: quoted };
    }
  }

  const result = apply({ op, ...filled });

  // Remember what was touched, but only on success and only when an element was named:
  // a refused op has changed nothing, so it is not what "it" means, and a deck-wide
  // colour has no element to carry forward.
  if (result.ok && filled.ref) {
    lastTarget = {
      ref: filled.ref,
      op,
      label: result.label,
      slideIndex: context.slideIndex,
    };
  }

  return receipt(result, severalEdits(text));
};

/**
 * Does this instruction ask for more than one change?
 *
 * One op per turn is the pipeline's shape, and the failure it produced was silent: "replace
 * first bullet with \"one\", second with \"two\"" made one edit and reported "Done.", so the
 * presenter had no way to know half the request had been dropped. It cannot be answered by
 * doing both -- the route and fill passes each decide a single op -- but it can be SAID.
 *
 * Two narrow signals, chosen to avoid crying wolf on ordinary instructions: two or more
 * quoted replacements, or an explicit first/second pairing. "Make the first bullet bigger"
 * trips neither.
 */
const severalEdits = (text) => {
  if (quotedParts(text).length >= 2) return true;
  return (
    /\b(first|1st)\b/i.test(text) &&
    /\b(second|2nd|third|3rd|secondly)\b/i.test(text)
  );
};

/**
 * The quoted strings in an instruction.
 *
 * DOUBLE quotes only, straight or curly. Single quotes are not delimiters here because
 * English is full of apostrophes -- "I'm Ryan Roemer" and "don't change the title" would both
 * parse as quoted text and swallow the instruction around them.
 */
const quotedParts = (text) =>
  [...text.replace(/[\u201c\u201d]/g, '"').matchAll(/"([^"]{1,140})"/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);

/**
 * The replacement text, when the instruction states it outright.
 *
 * Taken from the instruction rather than from the model, for the same reason as the ref: it is
 * deterministic, and the model measurably got it wrong. Asked to replace a bullet with "one"
 * it returned the element's EXISTING wording -- it copied what the slide said instead of what
 * was asked for, which is how a receipt came to claim a change that had not happened.
 *
 * The FIRST quoted string when there are several. "replace first bullet with \"one\", second
 * with \"two\"" resolves its target from the first ordinal too, so first-with-first is the
 * consistent pairing -- and it turns what was a silent no-op reporting "Done." into one
 * correct edit plus `severalEdits` saying the rest was not done.
 */
const quotedReplacement = (text) => quotedParts(text)[0] ?? null;

/**
 * Turn a result into what the presenter reads.
 *
 * Receipts are generated from what was APPLIED, never from what was asked for, so a
 * partial text replace or a clamped slide number shows up as itself.
 */
const receipt = (result, several = false) => {
  if (!result.ok) return { text: result.message };
  const done = result.note ?? "Done.";
  return {
    text: several
      ? `${done} I can only make one change per message — ask again for the rest.`
      : done,
    receipts: [{ label: result.label }],
  };
};
