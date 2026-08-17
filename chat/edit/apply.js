/**
 * Ops in, deck changes out. The ONLY module that writes to the deck.
 *
 * Every result carries a `label` for the receipt, generated from what was ACTUALLY
 * APPLIED rather than from what was asked for.
 *
 * THE RECEIPT-LIES FAMILY is why the validation here is not ceremony. A schema can only
 * check shape, so accepting any non-empty string as a CSS value produces "Done." for a
 * change nothing on the slide reflects -- worse than a refusal, because the presenter
 * stops looking:
 *
 *   - `font-size: bigger` -- not a CSS value, so the declaration is dropped on parse.
 *   - `font-size: larger` -- valid CSS, and it makes the title-slide subtitle SMALLER,
 *     46px to 19.2px, because `larger` resolves against the PARENT.
 *   - `color` on the display title -- painted by a gradient clipped to the glyphs, so
 *     setting `color` changes the computed value and nothing else.
 *
 * The rule to apply to the next one that looks like these: ASK THE BROWSER, DON'T TRUST
 * THE STRING. `CSS.supports` and `getComputedStyle` answer all three exactly.
 *
 * Never throws. A bad op is a message, not a crash.
 */
import { resolveNode } from "../harvest/index.js";
import { describeNode } from "../harvest/views.js";
import {
  captureBaseline,
  isMixed,
  mainTextValue,
  push,
  reset,
  undo,
} from "./patches.js";

/**
 * The properties an edit may set.
 *
 * An allowlist rather than "any CSS property", and the SAME list builds the
 * tool's `inputSchema` enum -- so a value the schema accepts is a value this
 * accepts, and the two cannot drift into disagreement.
 */
export const STYLE_PROPS = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "line-height",
  "text-align",
  "text-transform",
  "text-decoration",
  "opacity",
  "border-radius",
];

/** Custom properties the deck itself defines, so an override has something to override. */
export const CSS_VARS = [
  "--chapter-accent",
  "--chapter-accent-base",
  "--surface-1",
  "--surface-2",
  "--hairline",
  "--muted",
];

/** Classes with a defined meaning in `deck/styles.css`. */
export const TOGGLE_CLASSES = [
  "em",
  "takeaway--compact",
  "card--dense",
  "heading--fixed",
];

/**
 * A layout guard for the 1366x768 canvas.
 *
 * REJECTED, never truncated: a mid-word cut landing on a live slide is worse
 * than a refusal.
 */
export const MAX_TEXT = 140;

/**
 * Turn "bigger" into a size that is actually bigger.
 *
 * CSS's own `larger` and `smaller` resolve against the PARENT's font size, not the
 * element's: the title-slide subtitle computes to 46px inside a 16px container, so
 * `font-size: larger` takes it to 19.2px -- "make it bigger" shrinking it by half, with a
 * receipt reporting success.
 *
 * Resolved here against the element's OWN computed size, which also makes the receipt
 * report the px the slide got rather than a keyword whose meaning depends on where it
 * landed. Font-size only: it is where "bigger" is asked for and where the trap bites.
 */
const RELATIVE_SIZES = {
  bigger: 1.2,
  larger: 1.2,
  smaller: 1 / 1.2,
  tinier: 1 / 1.2,
};

const resolveSize = (prop, value, el) => {
  // `hasOwn` rather than a bare lookup: `RELATIVE_SIZES["constructor"]` returns a
  // function, which multiplies to `NaNpx`. That currently degrades safely into the
  // `CSS.supports` refusal below, but only by accident.
  const key = String(value).toLowerCase();
  const factor = Object.hasOwn(RELATIVE_SIZES, key)
    ? RELATIVE_SIZES[key]
    : null;
  if (prop !== "font-size" || !factor || !el) return value;

  const current = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(current) || current <= 0) return value;
  return `${Math.round(current * factor)}px`;
};

/**
 * Is this element's text painted by a background rather than by `color`?
 *
 * The deck's display title is `background-clip: text` with a gradient and both
 * `color` and `-webkit-text-fill-color` transparent, so the glyphs show the
 * gradient through. Setting `color` on it does exactly nothing visible.
 */
const paintedByBackground = (el) => {
  if (!el) return false;
  const cs = getComputedStyle(el);
  const clip = cs.webkitBackgroundClip || cs.backgroundClip;
  return clip === "text" && (cs.backgroundImage || "none") !== "none";
};

/**
 * The declarations needed to make a colour change actually show.
 *
 * `-webkit-text-fill-color` WINS over `color` wherever both are set, so it has
 * to be part of any colour change or gradient-painted text ignores us. Emitted
 * for every element, not just the gradient ones: on ordinary text it resolves to
 * the same colour and changes nothing, which is a much better deal than sniffing
 * the element and getting it wrong.
 */
const colourDeclarations = (value) =>
  `color: ${value}; -webkit-text-fill-color: ${value}`;

const fail = (message) => ({ ok: false, message });
const done = (label, note) => ({ ok: true, label, note });

/** Resolve a node id to `{ node, el }`, or a refusal. */
const target = (id) => {
  const node = resolveNode(id);
  if (!node) return { error: fail(`No node ${id} — the deck may have moved.`) };
  if (!node.element) {
    return { error: fail(`${id} has no element on screen right now.`) };
  }
  return { node, el: node.element };
};

export const setText = (id, text) => {
  const value = String(text ?? "");
  if (!value.trim()) return fail("Give me some text.");
  if (value.length > MAX_TEXT) {
    return fail(
      `That is ${value.length} characters; anything over ${MAX_TEXT} overflows the slide. Shorten it and try again.`,
    );
  }

  const found = target(id);
  if (found.error) return found.error;

  // The baseline is the TEXT NODE's own value, not the harvested node text --
  // they differ wherever there is inline markup. See `mainTextValue`.
  const original = mainTextValue(found.el);
  if (!original) return fail(`${id} has no editable text run.`);

  captureBaseline(id, "text", {
    kind: "text",
    index: original.index,
    value: original.value,
  });
  const was = found.node.text;
  push({
    kind: "text",
    id,
    textIndex: original.index,
    text: value,
    label: `text ${id} → "${value}"`,
  });

  // BOTH SIDES, and the new one last. `describeNode` reads the fiber tree, which
  // still holds the authored wording -- React never learns about a `nodeValue`
  // write, which is exactly what makes the edit durable. So a receipt built from
  // it alone quotes the text that was just replaced and reads as a no-op.
  return done(
    `${describeNode(id) ?? `${id} — "${was}"`} → "${value}"`,
    // Reported, never silently mangled: `nodeValue` on the longest text node
    // covers the sentence but not an `em()` span or an `<Icon>` beside it.
    isMixed(found.el)
      ? `${id} contains inline markup, so only its main text run changed.`
      : null,
  );
};

export const setStyle = (id, property, value) => {
  const prop = String(property ?? "").toLowerCase();
  if (!STYLE_PROPS.includes(prop)) {
    return fail(
      `I can't set "${property}". I can set: ${STYLE_PROPS.join(", ")}.`,
    );
  }

  const found = target(id);
  if (found.error) return found.error;

  const resolved = resolveSize(prop, value, found.el);

  // Ask the browser whether the declaration is even real. Without this,
  // "make it bigger" filled in `font-size: bigger` -- not a CSS value, so it was
  // dropped on parse, nothing moved, and the receipt still said "Done."
  if (!CSS.supports(prop, resolved)) {
    return fail(`"${value}" isn't a value ${prop} accepts.`);
  }

  const declarations =
    prop === "color" ? colourDeclarations(resolved) : `${prop}: ${resolved}`;

  push({
    kind: "css",
    id,
    selector: `[data-deck-ref="${id}"]`,
    declarations,
    label: `${prop} ${id} → ${resolved}`,
  });

  return done(
    `${prop} on ${describeNode(id) ?? id} → ${resolved}`,
    prop === "color" && paintedByBackground(found.el)
      ? "That heading was painted with a gradient; a flat colour replaces that treatment."
      : null,
  );
};

export const toggleClass = (id, className, on) => {
  if (!TOGGLE_CLASSES.includes(className)) {
    return fail(
      `I can't toggle "${className}". I can toggle: ${TOGGLE_CLASSES.join(", ")}.`,
    );
  }
  // NEVER `Boolean(value)`: `on: "false"` is truthy and would ADD the class the
  // caller asked to remove.
  const wanted = on === true || on === "true" || on === 1 || on === "1";

  const found = target(id);
  if (found.error) return found.error;

  captureBaseline(id, `class:${className}`, {
    kind: "class",
    className,
    value: found.el.classList.contains(className),
  });
  push({
    kind: "class",
    id,
    className,
    on: wanted,
    label: `${wanted ? "add" : "remove"} .${className} ${id}`,
  });

  return done(
    `${wanted ? "Added" : "Removed"} .${className} on ${describeNode(id) ?? id}`,
  );
};

export const setVariable = (name, value, scope, chapter) => {
  if (!name) {
    // Named separately from the unknown-name case: a MISSING name usually means
    // the caller meant a single element, and `I can't change "undefined"` sends
    // the reader looking for a broken variable instead of a misrouted request.
    return fail("Which variable? Try one of: " + CSS_VARS.join(", "));
  }
  if (!CSS_VARS.includes(name)) {
    return fail(`I don't know "${name}". I know: ${CSS_VARS.join(", ")}.`);
  }
  if (!String(value ?? "").trim()) return fail("Give me a value.");

  // The chapter is read from the DECK rather than taken from the caller: it
  // already knows which chapter it is on, and asking for a number it cannot see
  // is an invitation to guess.
  if (scope === "chapter" && !chapter) {
    return fail(
      "This slide doesn't belong to a chapter, so there's no chapter to scope to. Try the whole deck instead.",
    );
  }

  const selector = scope === "chapter" ? `.ch-${chapter}` : ":root";
  push({
    kind: "css",
    selector,
    declarations: `${name}: ${value}`,
    label: `${name} → ${value}${scope === "chapter" ? ` (chapter ${chapter})` : ""}`,
  });

  return done(
    `${name} → ${value}${scope === "chapter" ? ` for chapter ${chapter}` : " across the deck"}`,
  );
};

export const undoEdit = () => {
  const patch = undo();
  return patch ? done(`Undid: ${patch.label}`) : fail("Nothing to undo.");
};

export const resetEdits = () => {
  const count = reset();
  return done(
    count
      ? `Reset ${count} edit${count === 1 ? "" : "s"}. The deck is back as it shipped.`
      : "There was nothing to reset.",
  );
};
