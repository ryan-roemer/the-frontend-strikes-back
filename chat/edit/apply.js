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
    const { error } = target(ref);
    if (error) return fail(error);
    if (!value?.trim()) return fail("No value given.");

    setCss(
      `[data-chat-ref="${ref}"]`,
      `${prop}: ${value}`,
      `${prop} ${ref} → ${value}`,
    );
    return { ok: true, label: `${prop} ${ref} → ${value}` };
  },

  /** A custom property, at deck / chapter / element scope. */
  set_var: ({ name, value, scope = "deck", ref }) => {
    if (!CSS_VARS.includes(name)) return fail(`I can't change "${name}".`);
    if (!value?.trim()) return fail("No value given.");

    // The chapter is read from the deck rather than taken from the model: it
    // already knows which chapter it is on, and asking the model to supply a
    // number it cannot see is an invitation to guess.
    const slideIndex = activeIndex();
    const chapter = chapterOf(slideNodes()[slideIndex]);
    if (scope === "chapter" && !chapter) {
      return fail("This slide isn't inside a chapter.");
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
