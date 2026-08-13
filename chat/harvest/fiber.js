/* global document:false */

/**
 * REACT'S INTERNALS, IN ONE FILE.
 *
 * Everything unstable about this harvest lives here, the way `deck-adapter.js`
 * once held everything deck-specific. If React 20 renames `memoizedProps` or
 * drops the `__reactContainer$` handle, this file is the whole blast radius.
 *
 * Why the fiber tree rather than the DOM, which the previous harvest used:
 *
 *   - THERE IS NO SEMANTIC HTML. Spectacle's `Heading` and `Text` are both
 *     `styled.div`, so a rendered slide is divs all the way down and the only
 *     way to tell a title from a caption is to guess from a class name. In the
 *     fiber tree they are different components, which is not a guess.
 *   - CODE PANES ARRIVE INTACT. Prism renders source as hundreds of nested
 *     spans interleaved with `.linenumber` gutters; the fiber that produced it
 *     still holds the original string and its language.
 *   - MARKDOWN SLIDES CARRY THEIR SOURCE. Spectacle builds those slides
 *     internally, so the markdown is nowhere in `index.html` in usable form and
 *     nowhere in the DOM at all -- but it is right there in the fiber's props.
 *   - SPEAKER NOTES EXIST. `Notes` renders `null` outside presenter mode, which
 *     is why the DOM harvest documented them as unharvestable. Rendering null
 *     still means having a fiber, and that fiber holds the note.
 *
 * The entry point is the CONTAINER, not a slide element. Climbing `.return`
 * from a slide's DOM node was the first thing tried and it silently overshoots:
 * the 35 `Slide` fibers sit close together, so a climb of the wrong depth lands
 * on a shared ancestor and hands back five slides' notes as if they belonged to
 * one. Walking down from the root cannot make that mistake, and it needs no DOM
 * at all -- so it works in overview mode, where the slide elements move.
 */

/** React's handle on the root fiber, stamped onto the container element. */
const CONTAINER_PREFIX = "__reactContainer$";

/**
 * Depth cap.
 *
 * The deepest thing in this deck is a Prism-rendered code pane, which nests a
 * few dozen spans. 400 is far past anything real and exists only so a
 * cycle -- which the fiber graph does have, via `return` -- cannot hang the tab
 * if a future walk follows the wrong link.
 */
const MAX_DEPTH = 400;

/** `HostText`. Its `memoizedProps` IS the string, not an object wrapping one. */
const HOST_TEXT = 6;

/** Returned from a visitor to keep a subtree's children unvisited. */
export const SKIP = Symbol("skip");

/**
 * The fiber React is rendering the deck from.
 *
 * Null rather than throw when the handle is missing: the caller's job is to
 * fall back to the DOM, not to take the talk down. Same posture as
 * `bridge.js`, which warns instead of throwing when its context is absent.
 */
export const rootFiber = () => {
  const container = document.getElementById("root");
  if (!container) return null;

  const key = Object.keys(container).find((k) =>
    k.startsWith(CONTAINER_PREFIX),
  );
  return key ? (container[key] ?? null) : null;
};

/**
 * Depth-first over `child` and `sibling`, in render order.
 *
 * BOTH links are followed, and the sibling one is the reason notes work.
 * `Notes` renders `null`, so it contributes nothing to the DOM and sits on a
 * branch a DOM-shaped traversal would never reach -- but it is an ordinary
 * sibling in the fiber tree.
 *
 * Return `SKIP` from `visit` to keep a subtree's children unvisited. That is
 * how `Markdown` is handled: its props hold the source, and descending into
 * what Spectacle built from that source would report the same content twice.
 */
export const walk = (fiber, visit, depth = 0) => {
  let node = fiber;
  while (node) {
    if (visit(node, depth) !== SKIP && depth < MAX_DEPTH) {
      walk(node.child, visit, depth + 1);
    }
    node = node.sibling;
  }
};

/** Every fiber matching `predicate`, in render order. */
export const findAll = (fiber, predicate) => {
  const found = [];
  walk(fiber, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
};

/** A fiber's props, always an object so callers can destructure freely. */
export const propsOf = (fiber) => fiber?.memoizedProps ?? {};

/** The string a text fiber renders, or null if it is not a text fiber. */
export const textOf = (fiber) =>
  fiber?.tag === HOST_TEXT ? String(fiber.memoizedProps ?? "") : null;

/**
 * The class list on a fiber, as a string.
 *
 * Host elements carry it in props like everything else, so this reads the same
 * place for a `styled.div` and a hand-written `<span>`. The deck's class
 * vocabulary is a real semantic layer -- `styles.css` and the deleted
 * `deck-adapter.js` both treat it as one -- and it stays useful here for the
 * handful of distinctions component identity does not draw, such as which
 * `Text` is an eyebrow.
 */
export const classOf = (fiber) => {
  const { className } = propsOf(fiber);
  return typeof className === "string" ? className : "";
};

/** Whether a fiber carries a given class. */
export const hasClass = (fiber, name) =>
  classOf(fiber).split(/\s+/).includes(name);
