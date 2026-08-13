/* global DOMException:false */
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
  set_text: "Rewrite only the wording. Keep it short enough to fit the slide.",
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

  return receipt(result);
};

/**
 * Turn a result into what the presenter reads.
 *
 * Receipts are generated from what was APPLIED, never from what was asked for, so a
 * partial text replace or a clamped slide number shows up as itself.
 */
const receipt = (result) => {
  if (!result.ok) return { text: result.message };
  return {
    text: result.note ?? "Done.",
    receipts: [{ label: result.label }],
  };
};
