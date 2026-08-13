/* global CSS:false, getComputedStyle:false */
import {
  CSS_VARS,
  HEADING_TREATMENTS,
  STYLE_PROPS,
  TOGGLE_CLASSES,
  chapterOf,
  deckActions,
  nav,
  slideNodes,
  varSelector,
} from "../deck-adapter.js";
import { getSnapshot } from "../bus.js";
import { elementFor } from "./inventory.js";
import { locatorFor } from "./locator.js";
import {
  setClass,
  setCss,
  setText,
  undo as undoPatch,
  reset as resetPatches,
} from "./patches.js";

/**
 * Ops in, deck changes out. The ONLY module that writes to the deck.
 *
 * Every op is re-validated here even though the response schema already constrained
 * it. Two different reasons:
 *
 *   - Constrained decoding guarantees the SHAPE, not the truth. A ref that was
 *     valid when the inventory was built can be gone by the time the model answers,
 *     because the presenter pressed an arrow key.
 *   - The schema is built from these same allowlists, so validating against them
 *     here means a mismatch surfaces as a refusal rather than as a broken slide.
 *
 * Every result carries a `label` for the transcript receipt, so what the presenter
 * reads is generated from what was actually applied rather than from what was asked
 * for.
 */

const fail = (message) => ({ ok: false, message });

/**
 * Turn "bigger" into a size that is actually bigger.
 *
 * CSS's own `larger` and `smaller` resolve against the PARENT's font size, not the
 * element's. Measured: the title slide's subtitle computes to 46px inside a 16px
 * container, so `font-size: larger` took it to 19.2px -- "make it bigger" shrank it by
 * more than half, with a receipt cheerfully reporting success. Valid CSS, wrong answer,
 * and the kind of thing an audience notices before the presenter does.
 *
 * So relative sizes are resolved here against the element's OWN computed size. That
 * makes the value concrete before it is stored, which also means the receipt reports the
 * px the slide actually got rather than a keyword whose meaning depends on where it
 * landed.
 *
 * Deliberately font-size only. It is the property where "bigger" is asked for, and the
 * one where the parent-relative trap bites; anything else keeps the plain refusal, which
 * is a readable outcome rather than a guess.
 */
const RELATIVE_SIZES = {
  bigger: 1.2,
  larger: 1.2,
  smaller: 1 / 1.2,
  tinier: 1 / 1.2,
};

const resolveSize = (el, prop, value) => {
  if (prop !== "font-size") return value;
  const factor = RELATIVE_SIZES[value.toLowerCase()];
  if (!factor || !el) return value;
  const current = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(current) || current <= 0) return value;
  return `${Math.round(current * factor)}px`;
};

const activeIndex = () => getSnapshot().activeView?.slideIndex ?? null;

/** Resolve a ref to an element plus a durable locator, or explain why not. */
const target = (ref) => {
  const el = elementFor(ref);
  if (!el) return { error: `I can't find ${ref} on this slide any more.` };
  const slideIndex = activeIndex();
  if (slideIndex == null) return { error: "The deck isn't ready." };
  const locator = locatorFor(el, slideIndex);
  if (!locator) return { error: `${ref} isn't addressable.` };
  return { el, locator };
};

const OPS = {
  /** Rewrite one element's text. */
  set_text: ({ ref, text }) => {
    const { el, locator, error } = target(ref);
    if (error) return fail(error);
    if (!text?.trim()) return fail("No replacement text given.");

    const result = setText(el, locator, text, `text ${ref} → “${text}”`);
    if (!result.ok) return fail(`${ref} has no text to replace.`);
    return {
      ok: true,
      label: `text ${ref} → “${text}”`,
      note: result.partial
        ? `${ref} contains inline markup, so only its main text changed.`
        : null,
    };
  },

  /** One CSS property on one element, via the chat's stylesheet. */
  set_style: ({ ref, prop, value }) => {
    if (!STYLE_PROPS.includes(prop)) return fail(`I can't change "${prop}".`);
    const { el, error } = target(ref);
    if (error) return fail(error);
    if (!value?.trim()) return fail("No value given.");

    const resolved = resolveSize(el, prop, value.trim());

    // Ask the browser whether the declaration is even real.
    //
    // Without this, "make it bigger" filled in `font-size: bigger` -- not a CSS value, so
    // the declaration was dropped on parse, nothing moved on the slide, and the receipt
    // still said "Done. font-size e3 → bigger". A receipt reporting a change that did not
    // happen is worse than a refusal, because the presenter stops looking.
    //
    // `CSS.supports` is the exact question and it is native, so there is no property table
    // to maintain here.
    if (!CSS.supports(prop, resolved)) {
      return fail(`"${value}" isn't a value ${prop} accepts.`);
    }

    setCss(
      `[data-chat-ref="${ref}"]`,
      `${prop}: ${resolved}`,
      `${prop} ${ref} → ${resolved}`,
    );
    return { ok: true, label: `${prop} ${ref} → ${resolved}` };
  },

  /** A custom property, at deck / chapter / element scope. */
  set_var: ({ name, value, scope = "deck", ref }) => {
    // Named separately from the unknown-name case: a MISSING name means the fill pass
    // dropped it, which is usually the router having chosen this op for an instruction
    // about a single element. Saying `I can't change "undefined"` sent the reader
    // looking for a broken variable instead of a misrouted turn.
    if (!name) {
      return fail(
        "I couldn't tell which deck colour you meant. Name one of the deck's colours, " +
          "or say which element to recolour.",
      );
    }
    if (!CSS_VARS.includes(name)) {
      return fail(`"${name}" isn't one of the deck's colours.`);
    }
    if (!value?.trim()) return fail("No value given.");

    // The chapter is read from the deck rather than taken from the model: it
    // already knows which chapter it is on, and asking the model to supply a
    // number it cannot see is an invitation to guess.
    const slideIndex = activeIndex();
    const chapter = chapterOf(slideNodes()[slideIndex]);
    if (scope === "chapter" && !chapter) {
      // Reachable on the title slide, which belongs to no chapter -- and the presenter
      // has no way to know that is what "chapter" scope depends on, so say what to do
      // rather than only what went wrong.
      return fail(
        "This slide isn't inside a chapter, so there's no chapter colour to change. " +
          "Ask for the whole deck, or name the element you want recoloured.",
      );
    }
    if (scope === "element" && !ref) return fail("No element given.");

    const selector = varSelector(scope, { chapter, ref });
    setCss(selector, `${name}: ${value}`, `${name} → ${value} (${scope})`);
    return { ok: true, label: `${name} → ${value} (${scope})` };
  },

  /** Toggle a design-system class. */
  toggle_class: ({ ref, class: className, on = true }) => {
    if (!TOGGLE_CLASSES.includes(className)) {
      return fail(`I can't apply "${className}".`);
    }
    const { el, locator, error } = target(ref);
    if (error) return fail(error);

    setClass(
      el,
      locator,
      className,
      on,
      `${on ? "+" : "−"}${className} ${ref}`,
    );
    return { ok: true, label: `${on ? "+" : "−"}${className} ${ref}` };
  },

  /**
   * Move around the deck.
   *
   * Deliberately NOT recorded in the patch log: undo means "undo edits", and
   * folding navigation into it would make one button mean two things. An arrow key
   * recovers slide position.
   */
  goto: ({ where, slideIndex, chapter }) => {
    const { slideCount } = getSnapshot();
    const actions = {
      next: () => nav.next(),
      prev: () => nav.prev(),
      nextSlide: () => nav.nextSlide(),
      prevSlide: () => nav.prevSlide(),
      first: () => nav.toSlide(1),
      last: () => nav.toSlide(slideCount || 1),
      slide: () => nav.toSlide(slideIndex),
      chapter: () => nav.toChapter(chapter),
    };
    const action = actions[where];
    if (!action) return fail(`I don't know how to go "${where}".`);
    if (where === "slide" && !slideIndex) return fail("No slide number given.");
    if (where === "chapter" && !chapter) return fail("No chapter given.");

    const moved = action();
    if (!moved) return fail("I couldn't move the deck.");
    const label =
      where === "slide"
        ? `→ slide ${slideIndex}`
        : where === "chapter"
          ? `→ chapter ${chapter}`
          : `→ ${where}`;
    return { ok: true, label, transient: true };
  },

  /** Deck-level Spectacle surfaces. */
  deck_action: ({ action, value }) => {
    if (action === "fullscreen") {
      return deckActions.fullscreen()
        ? { ok: true, label: "toggled fullscreen", transient: true }
        : fail("I couldn't find the fullscreen control.");
    }
    if (action === "heading_style") {
      if (!HEADING_TREATMENTS.includes(value)) {
        return fail(
          `Heading style must be one of: ${HEADING_TREATMENTS.join(", ")}.`,
        );
      }
      deckActions.headingStyle(value);
      return { ok: true, label: `heading style → ${value}`, transient: true };
    }
    return fail(`I don't know the action "${action}".`);
  },

  undo: () => {
    const patch = undoPatch();
    return patch
      ? { ok: true, label: `undid: ${patch.label}`, transient: true }
      : fail("There's nothing to undo.");
  },

  reset: () => {
    resetPatches();
    return { ok: true, label: "reverted every edit", transient: true };
  },
};

/** Run one op. Never throws: a bad op is a message, not a crash. */
export const apply = (op) => {
  const handler = OPS[op?.op];
  if (!handler) return fail(`I don't know how to do "${op?.op}".`);
  try {
    return handler(op);
  } catch (err) {
    return fail(err.message || "That didn't work.");
  }
};

export const OP_NAMES = Object.keys(OPS);
