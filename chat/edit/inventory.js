/* global document:false, NodeFilter:false */
import { SKIP_SELECTOR, activeSlideNode, roleOf } from "../deck-adapter.js";
import { getSnapshot } from "../bus.js";
import { locatorFor } from "./locator.js";

/**
 * The addressable elements on the active slide, numbered for the model.
 *
 * The numbering is the whole point. A small model cannot author a CSS selector
 * for this deck -- Spectacle's `Heading` and `Text` are both `styled.div`, so
 * there is no `<h1>` to select and the classes are a mix of generated `sc-*`
 * hashes and semantic names. And a plausible-but-wrong selector fails SILENTLY:
 * it matches nothing, or forty things.
 *
 * So the model never writes an address. It picks one from a list, and the list's
 * ids are spliced into the response schema as an `enum` -- which makes a
 * hallucinated reference not merely wrong but undecodable.
 */

const MAX_REFS = 24;
const MAX_TEXT = 60;
const MIN_TEXT = 2;

/** Direct text-node children with real content, in document order. */
const textNodesOf = (el) =>
  [...el.childNodes].filter(
    (node) => node.nodeType === 3 && node.nodeValue.trim().length >= MIN_TEXT,
  );

/**
 * Walk the active slide and number what can be addressed.
 *
 * Refs are assigned in document order and an existing `data-chat-ref` is REUSED,
 * so the same DOM yields the same ids every turn -- "make that bigger too" has to
 * resolve to the same element on the following turn.
 */
export const build = () => {
  const slide = activeSlideNode();
  const { activeView } = getSnapshot();
  if (!slide || !activeView) return { slideIndex: null, entries: [], refs: [] };

  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) =>
      el.closest(SKIP_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });

  const entries = [];
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (entries.length >= MAX_REFS) break;

    const role = roleOf(el);
    if (!role) continue;

    const texts = textNodesOf(el);
    if (!texts.length) continue;

    const ref = el.dataset.chatRef || `e${entries.length + 1}`;
    // Safe to write: React never manages an attribute absent from its props, so
    // this survives every re-render and is lost only on remount. It doubles as
    // the CSS hook for style patches.
    el.dataset.chatRef = ref;

    entries.push({
      ref,
      role,
      text: el.textContent.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT),
      // More than one text node, or any element children, means a text replace
      // would only cover part of it -- `${em(...)}`, an `<${Icon}>`, a `<${Link}>`.
      mixed: texts.length > 1 || el.children.length > 0,
      locator: locatorFor(el, activeView.slideIndex),
    });
  }

  return {
    slideIndex: activeView.slideIndex,
    entries,
    refs: entries.map((e) => e.ref),
  };
};

/**
 * The inventory as prompt text.
 *
 * Line-oriented, id first. A JSON inventory costs roughly 2.5x the tokens and
 * invites a small model to echo the structure back instead of emitting an op.
 */
export const serialize = (
  inventory,
  { chapter, chapterTitle, stepCount } = {},
) => {
  if (!inventory.entries.length)
    return "No addressable elements on this slide.";

  const header = [
    `SLIDE ${inventory.slideIndex + 1}`,
    chapter
      ? `chapter ${chapter}${chapterTitle ? ` "${chapterTitle}"` : ""}`
      : null,
    stepCount ? `${stepCount} steps` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const rows = inventory.entries.map(
    ({ ref, role, text, mixed }) =>
      `${ref.padEnd(4)}${role.padEnd(16)}"${text}"${mixed ? "  (mixed)" : ""}`,
  );

  return [header, ...rows].join("\n");
};

/** The live element for a ref, or null. */
export const elementFor = (ref) => {
  const slide = activeSlideNode();
  return slide?.querySelector(`[data-chat-ref="${ref}"]`) ?? null;
};
