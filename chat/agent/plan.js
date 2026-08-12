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
  const inventory = build();
  const chapter = chapterOf(slideNodes()[activeView?.slideIndex ?? 0]);
  return {
    inventory,
    chapter,
    text: serialize(inventory, {
      chapter,
      chapterTitle: chapterTitle(chapter),
    }),
    slideCount: slideCount || 35,
  };
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

const ROUTE_SYSTEM = [
  "You classify one instruction from someone presenting a slide deck.",
  "Choose exactly one op:",
  "- answer: they asked a question, or want information. THE DEFAULT.",
  "- set_text: change the words of an element.",
  "- set_style: change how an element looks (size, colour, weight, spacing).",
  "- set_var: change a deck-wide or chapter-wide colour.",
  "- toggle_class: apply or remove a named style class.",
  "- goto: move to another slide or chapter.",
  "- deck_action: fullscreen, or change the heading treatment.",
  "- undo: reverse the last change.",
  "- reset: reverse every change.",
  "If it is not clearly an instruction to change or move something, choose answer.",
].join("\n");

const fillSystem = (op, context) =>
  [
    `You are filling in the details of a "${op}" instruction for a slide deck.`,
    "Use ONLY the element ids listed below. Reply with the fields the schema asks for.",
    "",
    context.text,
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
      system: ROUTE_SYSTEM,
      message: `INSTRUCTION: ${text}`,
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
  if (op === "undo" || op === "reset") return receipt(apply({ op }));

  let filled;
  try {
    filled = await decode({
      system: fillSystem(op, context),
      message: `INSTRUCTION: ${text}`,
      schema: opSchema({
        refs: context.inventory.refs,
        slideCount: context.slideCount,
      })[op],
      label: op,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    return {
      text: `I understood that as a ${op.replace(/_/g, " ")}, but couldn't work out the details (${err.message}).`,
    };
  }

  return receipt(apply({ op, ...filled }));
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
