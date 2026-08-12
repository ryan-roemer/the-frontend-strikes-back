/* global document:false, BroadcastChannel:false */
import { chapters } from "../deck/chapters.js";
import { AUDIENCES, PARTS, VERDICTS, takeaways } from "../deck/takeaways.js";
import { HEADING_STYLES } from "../deck/theme.js";
import { getSnapshot } from "./bus.js";

/**
 * THE ONLY DECK-AWARE MODULE.
 *
 * Everything else in `chat/` gets its vocabulary from here: which classes mean
 * what, which regions are off limits, which custom properties and classes may be
 * touched, and how to move around. Porting the assistant to another deck should
 * be rewriting this file and nothing else.
 *
 * It imports from `../deck/` deliberately -- and only the DATA modules. `chapters`
 * and `takeaways` exist precisely because this deck refuses to keep the same fact
 * in two places (`takeaways.js`: "Edit the claim here and all three move
 * together"), which makes them the best possible source of deck knowledge: they
 * are structured, they are authoritative, and they cannot go stale relative to
 * the slides. Re-deriving any of it from the DOM would be strictly worse.
 */

// --- Structural knowledge ---------------------------------------------------

export const CHAPTERS = chapters.map(({ n, title }) => ({ n, title }));

export const TAKEAWAYS = takeaways.map(
  ({ n, part, chapter, text, detail, verdict }) => ({
    n,
    part,
    chapter,
    text,
    detail,
    verdict,
  }),
);

export const AUDIENCE_CARDS = AUDIENCES.map(({ who, claim, action }) => ({
  who,
  claim,
  action,
}));

export const PART_TITLES = Object.values(PARTS).map(({ key, title }) => ({
  key,
  title,
}));

export const VERDICT_MEANINGS = Object.entries(VERDICTS).map(
  ([key, { title }]) => ({ key, title }),
);

// --- Element roles ----------------------------------------------------------

/**
 * Class -> the word the model sees.
 *
 * Tag names are useless here: Spectacle's `Heading` and `Text` are both
 * `styled.div`, so there is no `<h1>` anywhere in the deck and no way to tell a
 * title from a caption structurally. The deck's own class vocabulary is the only
 * semantic layer that exists, which is why the role map is a deck concern and
 * lives in this file.
 *
 * Order matters: first match wins, so the specific classes come before `.em`,
 * which appears nested inside many of them.
 */
const ROLES = [
  [".slide-title", "title"],
  [".slide-subtitle", "subtitle"],
  [".title-display", "title"],
  [".title-subtitle", "subtitle"],
  [".eyebrow", "eyebrow"],
  [".divider__title", "chapter title"],
  [".divider__numeral", "chapter number"],
  [".roadmap__title", "roadmap item"],
  [".roadmap__index", "roadmap number"],
  [".takeaway__text", "takeaway"],
  [".takeaway__detail", "takeaway detail"],
  [".card__label", "card label"],
  [".matrix__name", "matrix row"],
  [".matrix__note", "matrix note"],
  [".audience__who", "audience"],
  [".audience__claim", "audience claim"],
  [".audience__action", "audience action"],
  [".demo__url", "demo url"],
];

/**
 * The role of an element, or null if it is not addressable.
 *
 * List items get a running number within their list, because "bullet 3" is how a
 * presenter refers to them and there is no class that distinguishes one `li` from
 * the next.
 *
 * The `"text"` fallback matters more than it looks. Plenty of slide copy is a bare
 * Spectacle `<${Text}>` with no class in the list above -- the "Hi! I'm Ryan
 * Roemer" line, for one -- and without a fallback the inventory skipped all of it,
 * so the assistant could restyle a heading but not touch a paragraph. Anything
 * holding its own text is addressable; a wrapper that only contains other elements
 * still is not, because the inventory requires a direct text node.
 */
export const roleOf = (el) => {
  for (const [selector, role] of ROLES) {
    if (el.matches(selector)) return role;
  }
  if (el.tagName === "LI") {
    const index = [...el.parentElement.children].indexOf(el) + 1;
    return `bullet ${index}`;
  }
  // Elements that exist to lay out other elements are never edit targets.
  if (["UL", "OL", "TABLE", "TR", "TBODY", "THEAD"].includes(el.tagName)) {
    return null;
  }
  return "text";
};

/**
 * Regions the inventory must never enter.
 *
 * CodeMirror (via react-live) owns its DOM and re-renders it on any change, so a
 * text patch there is both meaningless and destructive. Prism does the same for
 * static code panes. The notes portal only exists in presenter mode.
 */
export const SKIP_SELECTOR =
  ".react-live-editor, .npm__react-simple-code-editor__textarea," +
  " .prism-code, .code-frame, .notes, .spectacle-notes";

// --- What may be changed ----------------------------------------------------

/**
 * Style properties the model may set.
 *
 * Short on purpose. The canvas is a fixed 1366x768 and every slide is laid out
 * against it, so anything that changes the box model in a big way (width,
 * position, display, flex) turns one instruction into a broken slide. These are
 * the properties that change how something LOOKS without moving anything else.
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
  "padding",
  "max-width",
];

/** Custom properties worth exposing, all defined in `deck/styles.css`. */
export const CSS_VARS = [
  "--chapter-accent",
  "--chapter-accent-base",
  "--surface-1",
  "--surface-2",
  "--hairline",
  "--muted",
];

/** Design-system classes that mean something on their own. */
export const TOGGLE_CLASSES = [
  "em",
  "takeaway--compact",
  "card--dense",
  "heading--fixed",
];

/** Heading treatments, straight from the theme so the two cannot disagree. */
export const HEADING_TREATMENTS = HEADING_STYLES;

/**
 * Where a custom-property override has to be written.
 *
 * `--chapter-accent` is emitted by `applyChapterStyles()` onto `.ch-N` (see
 * deck/chapters.js), so a `:root` override LOSES the cascade -- the chapter rule
 * is more specific and would keep winning. A chapter-scoped edit therefore has to
 * match that specificity and win on document order instead, which it does because
 * the chat's stylesheet is appended after the chapter one.
 */
export const varSelector = (scope, { chapter, ref } = {}) => {
  if (scope === "chapter" && chapter) return `.ch-${chapter}`;
  if (scope === "element" && ref) return `[data-chat-ref="${ref}"]`;
  return ":root";
};

// --- The deck's DOM ---------------------------------------------------------

/**
 * Every slide element, in slide order.
 *
 * Spectacle portals all 35 slides into one node and only toggles their `display`,
 * so they are all here all the time -- which is what makes whole-deck harvesting
 * possible without navigating. `TemplateWrapper` is a sibling among them (it is
 * portaled first), so it is excluded by identity rather than by index arithmetic.
 */
export const slideNodes = () => {
  const { slidePortalNode, templateWrapperNode } = getSnapshot();
  if (!slidePortalNode) return [];
  return [...slidePortalNode.children].filter(
    (el) => el !== templateWrapperNode && !el.hasAttribute("data-chat-bridge"),
  );
};

/**
 * The deck's own slide element inside a portal child.
 *
 * A portal child is react-spring's `AnimatedDiv`: a wrapper whose class is a
 * generated `sc-*` pair and whose inline `style` is rewritten every animation
 * frame. The deck's classes -- `.slide`, `ch-N`, `divider`, `md` -- all live one
 * level down, on the element `DeckSlide` and `mdSlideProps` label. That inner
 * element is the right root for everything here: it carries the semantics, and it
 * is not the node react-spring is fighting us for.
 */
export const slideRoot = (portalChild) => {
  if (!portalChild) return null;
  if (portalChild.classList?.contains("slide")) return portalChild;
  return portalChild.querySelector(".slide") ?? portalChild;
};

export const activeSlideNode = () => {
  const { activeView } = getSnapshot();
  if (!activeView) return null;
  return slideRoot(slideNodes()[activeView.slideIndex]) ?? null;
};

/**
 * The chapter a slide belongs to, read off the class the deck already puts there.
 *
 * Has to go through `slideRoot`: the class is on the inner slide element, not on
 * the portal child, and reading `className` off the wrapper silently returned
 * `null` for all 35 slides on the first attempt.
 */
export const chapterOf = (slideNode) => {
  const root = slideRoot(slideNode);
  const match = root?.className?.match?.(/\bch-(\d)\b/);
  return match ? Number(match[1]) : null;
};

// --- Navigation -------------------------------------------------------------

/**
 * Drive Spectacle from outside its React tree.
 *
 * Primary path is the bridge, which hands over the very callbacks Spectacle's own
 * keyboard handler uses. The fallback is the presenter BroadcastChannel: Spectacle
 * listens for `{type:"SYNC"}` on `spectacle_presenter_bus` and calls `skipTo` with
 * the payload, with no filtering on the sender -- so it works even when the bridge
 * is unmounted, which is exactly the case in overview mode.
 */
const SYNC_CHANNEL = "spectacle_presenter_bus";

let channel = null;

const syncTo = (slideIndex, stepIndex = 0) => {
  try {
    channel = channel ?? new BroadcastChannel(SYNC_CHANNEL);
    // Spectacle's `useBroadcastChannel` JSON-stringifies its messages and parses
    // them on receipt, so the wire format is a string, not an object.
    channel.postMessage(
      JSON.stringify({
        type: "SYNC",
        payload: { slideIndex, stepIndex },
        meta: { sender: "chat" },
      }),
    );
    return true;
  } catch {
    return false;
  }
};

const clamp = (value, max) => Math.min(Math.max(value, 0), Math.max(0, max));

/**
 * Spectacle's relative-navigation functions return UNDEFINED, not a boolean.
 *
 * So `!!deckNav.advanceSlide()` was always false, and `apply.js`'s `if (!moved)` turned every
 * working "next slide" into "I couldn't move the deck." -- the deck advanced and the receipt
 * said it had not. `toSlide` never had the bug because it returns `true` explicitly after
 * `skipTo`.
 *
 * Reporting success is the honest answer rather than a convenient one: Spectacle clamps at
 * both ends, so a call at the last slide is a no-op and not a failure. There is nothing to
 * detect either, because the move lands via a React state update rather than synchronously --
 * comparing the index before and after would read the old value and report failure again.
 */
const relative = (fn, fallback) => () => {
  const { nav: deckNav } = getSnapshot();
  if (!deckNav) return fallback();
  fn(deckNav);
  return true;
};

export const nav = {
  next: relative(
    (d) => d.stepForward(),
    () => syncTo(currentIndex() + 1),
  ),
  prev: relative(
    (d) => d.stepBackward(),
    () => syncTo(Math.max(0, currentIndex() - 1)),
  ),
  nextSlide: relative(
    (d) => d.advanceSlide(),
    () => syncTo(currentIndex() + 1),
  ),
  prevSlide: relative(
    (d) => d.regressSlide(),
    () => syncTo(Math.max(0, currentIndex() - 1)),
  ),
  /**
   * Jump to a slide, 1-based for the model's benefit.
   *
   * Always sends BOTH indices: `SKIP_TO` merges into the pending view, so leaving
   * `stepIndex` out carries the previous slide's step onto the new slide. And
   * always clamps, because `skipTo` does no bounds checking of its own -- an
   * out-of-range index leaves the deck pointing at no slide, which self-cancels
   * and looks like the command was simply ignored.
   */
  toSlide: (oneBased) => {
    const { nav: deckNav, slideCount } = getSnapshot();
    const slideIndex = clamp((oneBased | 0) - 1, (slideCount || 1) - 1);
    if (deckNav) {
      deckNav.skipTo({ slideIndex, stepIndex: 0 });
      return true;
    }
    return syncTo(slideIndex, 0);
  },
  /** First slide of a chapter, found by the class the deck already carries. */
  toChapter: (n) => {
    const index = slideNodes().findIndex((el) => chapterOf(el) === Number(n));
    if (index < 0) return false;
    return nav.toSlide(index + 1);
  },
};

const currentIndex = () => getSnapshot().activeView?.slideIndex ?? 0;

// --- Deck-level actions -----------------------------------------------------

/**
 * The other Spectacle surfaces worth exposing.
 *
 * MODE SWITCHES ARE NOT HERE, and that is a measured decision rather than caution.
 * Presenter, print and export mode each swap the entire view subtree. Overview mode
 * was implemented and then removed: it engages only through a synthetic
 * `mod+shift+o` whose modifier flags have to match the platform exactly, it renders
 * the deck template once PER SLIDE (35 `DeckBridge` instances -- see bridge.js), and
 * in testing the patch log did not come back intact across the transition. None of
 * the four is something a presenter would ask a chat window for mid-talk, and all
 * four are one keystroke away. Two actions that work beat three where one lies.
 *
 * If a future capability does need a mousetrap chord: the bindings are
 * `mod+shift+<key>` on `document`, mousetrap reads the legacy `e.which`, and
 * EXACTLY ONE of `metaKey`/`ctrlKey` may be set -- `mod` is command on Apple
 * platforms and ctrl elsewhere. Setting both yields `command+ctrl+shift+o`, which
 * matches nothing while `dispatchEvent` still returns true, so it fails silently
 * and looks like success. Dispatch on `document`; `window` is not in the path.
 */
export const deckActions = {
  fullscreen: () => {
    // Spectacle's own button, clicked. `requestFullscreen()` called directly would
    // need its own user-activation, and this way the deck's fullscreen state and
    // the button's icon cannot disagree.
    const button = document.querySelector(".spectacle-fullscreen-button");
    if (!button) return false;
    button.click();
    return true;
  },
  headingStyle: (value) => {
    if (!HEADING_TREATMENTS.includes(value)) return false;
    // `[data-heading]` on the root is exactly how `theme.js` applies the treatment,
    // so this is the deck's own mechanism rather than a parallel one.
    document.documentElement.dataset.heading = value;
    return true;
  },
};
