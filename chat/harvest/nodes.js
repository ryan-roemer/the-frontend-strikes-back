/**
 * Addressable nodes: what they are called, and how to get back to them.
 *
 * The harvest reads the deck as prose. This file is what makes a piece of that
 * prose a THING -- "slide 9, bullet 2" resolving to one specific text run, with
 * a role a presenter would recognise and a way back to the live element.
 *
 * WHY THIS IS CHEAP. Each `Heading` / `Text` / `ListItem` / `Quote` / `CodePane`
 * fiber owns exactly one text run, so component identity IS the node boundary --
 * there is no heuristic here for "where does a node start". That is the whole
 * reason the harvest walks fibers instead of the DOM, and it pays off twice:
 * once for serialization, once for addressing.
 *
 * Measured on this deck: 162 addressable fibers across 35 slides, mean 4.6. That number
 * tracks slide CONTENT and so drifts with every authoring pass -- `deckDump.nodes().length`
 * is the live answer, and the only reason to state one here is the order of magnitude.
 *
 * TWO KINDS OF POINTER, and the deck's own use cases separate them cleanly:
 *
 *   "change this slide's PHRASE_1 to PHRASE_2"  wants the SOURCE -- the JS you
 *                                               would edit. See `provenance.js`.
 *   "change the heading color of this slide"    wants the LIVE ELEMENT, because
 *                                               the change is a style applied to
 *                                               what is on screen right now.
 *
 * `elementOf` is the second one. There is no first-class API for the first,
 * because there cannot be -- `provenance.js` explains why.
 */
import {
  CodePane,
  Heading,
  ListItem,
  Notes,
  OrderedList,
  Quote,
  Slide,
  Text,
  UnorderedList,
} from "spectacle";
import { hasClass, propsOf, textOf } from "./fiber.js";

/** `nodeType` for an `Element`, so this file needs no DOM globals. */
const ELEMENT_NODE = 1;

/**
 * Depth cap for the host-node search.
 *
 * 40, not `fiber.js`'s 400, and the difference is the search, not a disagreement. That
 * one bounds a walk of the whole tree; this one climbs from a text node to its nearest
 * element, which is a handful of levels in anything real. Both are runaway guards set
 * far past the real number, sized to what they are guarding.
 */
const MAX_DEPTH = 40;

/**
 * Class -> the word a presenter would use.
 *
 * FIRST MATCH WINS, so specific classes come first. Chapter-divider headings
 * carry `slide-title heading--fixed divider__title` -- all three -- so
 * `divider__title` has to be ahead of `slide-title` or every chapter divider
 * reports itself as an ordinary slide title.
 *
 * This is the same class vocabulary `markdown.js` serializes from and
 * `styles.css` styles from, which is the point: the deck has no semantic HTML
 * (Spectacle renders `Heading` and `Text` as the same `styled.div`), so its
 * class names are the only naming layer that exists. Every entry below was
 * measured against the live tree rather than read off a stylesheet -- an
 * aspirational role for a class nothing renders is a role the model can never
 * use.
 */
const ROLES = [
  ["title-display", "title"],
  ["title-subtitle", "subtitle"],
  ["divider__title", "chapter title"],
  ["slide-title", "title"],
  ["slide-subtitle", "subtitle"],
  ["eyebrow", "eyebrow"],
  ["takeaway__text", "takeaway"],
  ["takeaway__detail", "takeaway detail"],
  ["card__label", "card label"],
  ["audience__who", "audience"],
  ["audience__claim", "audience claim"],
  ["audience__action", "audience action"],
  ["matrix__name", "matrix row"],
  ["matrix__note", "matrix note"],
  ["demo__url", "demo url"],
  ["qr-caption", "caption"],
];

/** Component identity -> the role, when no class is more specific. */
const KIND_ROLES = new Map([
  [Heading, "heading"],
  [Text, "text"],
  [ListItem, "bullet"],
  [Quote, "quote"],
  [CodePane, "code"],
]);

/** Whether a fiber is one of the five addressable kinds. */
export const isNodeKind = (fiber) => KIND_ROLES.has(fiber?.type);

/**
 * What this node IS.
 *
 * `fallback` covers the components that have no class of their own -- every
 * `ListItem` in the deck is bare, and 22 of the `Text` fibers are too.
 */
export const roleOf = (fiber, fallback) => {
  for (const [cls, role] of ROLES) {
    if (hasClass(fiber, cls)) return role;
  }
  return fallback ?? KIND_ROLES.get(fiber?.type) ?? "text";
};

/** Prose whitespace is layout, not content -- `htm` literals are full of it. */
export const normalize = (text) => text.replace(/\s+/g, " ").trim();

/**
 * One node's own text, and NOTHING ELSE'S.
 *
 * Deliberately not `walk` from `fiber.js`: that follows the entry fiber's
 * SIBLINGS as well as its children, so flattening a node with it returns that
 * node's text plus every later node on the slide. `fiber.js` records the
 * measurement -- an audience card came back as two `Text` fibers glued into
 * "If you build frontendsAgents are becoming users of your app." This recurses
 * `child` only.
 *
 * Deliberately not `childrenOf` from `markdown.js` either, tempting as the reuse
 * is: that one calls `serialize`, which writes notes, code panes and markdown
 * source into `ctx.sink` as it goes. Calling it a second time for node text
 * would report all three twice.
 *
 * THE SINGLE-TEXT-CHILD CASE IS THE COMMON CASE, not an edge one. React does not
 * create a fiber for an element whose only child is a string -- it sets the text
 * on the host node and leaves `fiber.child` null, with the string still in
 * props. Nearly every heading in this deck is `<Heading>Hi!</Heading>`, and
 * missing this is what once cost 25 of 35 slide titles.
 *
 * A NESTED LIST IS NOT THIS NODE'S TEXT. Stopping at one is what makes a parent
 * bullet addressable separately from its sub-bullets. Slide 9's third bullet used
 * to come back as "And the agent can be just about anywhere: Claude Desktop, over
 * a local relay A browser extension Or code running in the page itself" -- four
 * visible bullets in one string, so naming any of the three sub-items resolved to
 * their parent, and rewriting that parent's element would have taken the whole
 * sub-list with it.
 */
export const flattenNode = (fiber, depth = 0) => {
  if (!fiber || depth > MAX_DEPTH) return "";

  const text = textOf(fiber);
  if (text !== null) return text;

  const { type } = fiber;
  // Phosphor icons and Spectacle's own chrome carry no prose. Matrix rows lead
  // with an `Icon`, so without this every one of them would start with a stray
  // class-soup gap.
  if (type === "i" || type === "svg") return "";
  if (type === "br") return " ";
  // A note is a sibling of the content it belongs to, not part of it.
  if (type === Notes) return "";
  // The sub-items are their own nodes; see the note above.
  if (type === UnorderedList || type === OrderedList) return "";

  if (!fiber.child) {
    const { children } = propsOf(fiber);
    const kind = typeof children;
    return kind === "string" || kind === "number" ? String(children) : "";
  }

  let out = "";
  for (let node = fiber.child; node; node = node.sibling) {
    out += flattenNode(node, depth + 1);
  }
  return out;
};

/**
 * How deeply nested in lists a node is. 1 for a top-level bullet, 0 for anything
 * outside a list.
 *
 * A `.return` CLIMB, not a counter threaded through the walk, because the two
 * emission paths reach a `ListItem` differently -- `serialize` recurses into it
 * while the markdown scan walks onto it -- and a climb gives the same answer from
 * either. It also cannot drift out of step with the tree the way a carried depth
 * can.
 *
 * Stops at `Slide`, so it counts this slide's lists and not any wrapper above it.
 *
 * This is the number "the second bullet" resolves against. Without it, ordinals
 * run flat through the emission order -- on slide 9 that makes "the fourth
 * bullet" the first SUB-bullet, because three sub-items are emitted before the
 * fourth top-level one. Depth-scoped ordinals are what make the count match what
 * a presenter sees.
 */
const depthOf = (fiber) => {
  let depth = 0;
  for (let node = fiber?.return; node; node = node.return) {
    if (node.type === Slide) break;
    if (node.type === UnorderedList || node.type === OrderedList) depth += 1;
  }
  return depth;
};

/**
 * Record one addressable node against the slide being serialized.
 *
 * Ordinals are EMISSION ORDER, not a fiber path. `?animate=false` swaps `Appear`
 * for `Fragment`, so paths differ between modes while emission order does not --
 * an id has to mean the same thing under both, because the deck is presented
 * with animations and debugged without them.
 *
 * The fiber rides along NON-ENUMERABLY. `resolveNode` needs it to reach the live
 * element, but the fiber graph is cyclic (`return` points back up) and these
 * records get `JSON.stringify`d by `?dump` -- an enumerable fiber would throw on
 * a converting-circular-structure error the first time anyone dumped the deck.
 */
export const emitNode = (ctx, fiber, role, text) => {
  if (!text) return;

  const node = {
    ordinal: ctx.sink.nodes.length + 1,
    role,
    text,
    depth: depthOf(fiber),
  };
  Object.defineProperty(node, "fiber", { value: fiber, enumerable: false });
  ctx.sink.nodes.push(node);
};

/**
 * Whether a host fiber renders anything at all.
 *
 * A child fiber counts, and so does a string sitting in props -- that is the
 * single-text-child case again, where React puts the text on the host node and
 * leaves `fiber.child` null.
 */
const rendersContent = (fiber) => {
  if (fiber.child) return true;
  const kind = typeof propsOf(fiber).children;
  return kind === "string" || kind === "number";
};

/**
 * The live DOM element a node fiber rendered.
 *
 * Component fibers have no `stateNode`; the host one under them does. Every
 * addressable kind here renders a single styled host root, so the first host in
 * child-first order is the element -- and it is the element the deck's own CSS
 * already targets, which is what makes a style change land where the class
 * vocabulary says it should.
 *
 * EMPTY HOSTS ARE SKIPPED, and this is not defensive coding. Spectacle's
 * `CodePane` renders a zero-height `div.step-placeholder` as its FIRST child --
 * `deck/styles.css` has a rule working around the same div -- so the plain
 * child-first walk returned that placeholder for all three code panes. It is a
 * connected element with the right ancestors and no content, which is the worst
 * shape of wrong answer: a style applied to it lands on nothing visible and
 * reports success. An element with nothing in it never renders a node's content.
 *
 * Child-only, for the same reason `flattenNode` is: following siblings would
 * hand back the NEXT node's element on any component that renders null first.
 *
 * READ-ONLY, and it must stay that way. `docs/chat-handoff.md` §10: removing or
 * rewriting nodes React's fiber still references can throw `NotFoundError` from
 * `removeChild` on the next commit and unmount the root. A blank deck, mid-talk.
 */
export const elementOf = (fiber, depth = 0) => {
  if (!fiber || depth > MAX_DEPTH) return null;
  if (fiber.stateNode?.nodeType === ELEMENT_NODE && rendersContent(fiber)) {
    return fiber.stateNode;
  }

  for (let node = fiber.child; node; node = node.sibling) {
    const found = elementOf(node, depth + 1);
    if (found) return found;
  }
  return null;
};
