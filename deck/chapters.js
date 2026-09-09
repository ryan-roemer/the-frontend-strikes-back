import { colors, isLightPrint } from "./theme.js";
import { backgrounds } from "./media.js";

/**
 * Chapter identity: the single source of truth for the deck's section accents.
 *
 * Each chapter owns an accent color, a divider background, and its title. The
 * accent flows to three places -- the divider slide, the progress bar, and the
 * footer -- so a section reads as one continuous stretch of the talk.
 *
 * `text` tints are the palette's 50-stop, which all clear WCAG AA against the
 * midnight slide background; `base` is reserved for bars and glows where
 * saturation matters more than legibility.
 */
const ACCENTS = {
  green: { text: colors.green[50], base: colors.green.base },
  purple: { text: colors.purple[50], base: colors.purple.base },
  blue: { text: colors.blue[50], base: colors.blue.base },
  darkGreen: { text: colors.darkGreen[50], base: colors.darkGreen.base },
};

/**
 * The three chapters, and why they are these colors.
 *
 * `pillar` is what the divider's eyebrow reads -- "01 · Interface" -- and `title`
 * is the heading under it. The talk has two pillars, interface and runtime, and
 * a third chapter where they meet; naming the pillar on the divider is what
 * keeps a section from reading as one more topic in a list.
 *
 * The color assignment carries the argument:
 *
 *   1  blue        WebMCP. Held outside the gradient below, because it is the
 *                  interface chapter rather than a claim about what works.
 *   2  darkGreen   The confidence gradient: in-browser AI works with limits,
 *   3  purple      and a full agent workflow is further out still.
 *
 * Green is deliberately unspent. It stays the deck default (see `:root` in
 * styles.css), which is what gives the advice and closing slides -- the ones
 * that pass no chapter at all -- their own color without any data behind them.
 *
 * Changing one of these breaks a claim the slides make out loud -- see the
 * verdict marks in `takeaways.js`, which read `--chapter-accent` straight off
 * the slide.
 */
export const chapters = [
  {
    n: 1,
    pillar: "Interface",
    title: "WebMCP",
    accent: ACCENTS.blue,
    background: backgrounds.networkCables,
  },
  {
    n: 2,
    pillar: "Runtime",
    title: "AI in the browser",
    accent: ACCENTS.darkGreen,
    background: backgrounds.oldComputer,
  },
  {
    n: 3,
    pillar: "Web agents",
    title: "Trading time for limits",
    accent: ACCENTS.purple,
    background: backgrounds.postits,
  },
];

/** Chapters keyed by number, for `chapter(2)` lookups in the deck. */
export const chapter = (n) => chapters.find((c) => c.n === n);

/** Zero-padded chapter number, e.g. `02`. */
export const chapterNumber = (n) => String(n).padStart(2, "0");

/**
 * The class Spectacle puts on the slide's background element.
 *
 * `Slide` forwards `className`, and `MarkdownSlideSet` spreads unknown props
 * onto every slide it generates -- and each set in this deck is exactly one
 * chapter. So one prop per set scopes the accent to every slide inside it,
 * with no slide-index bookkeeping to drift as content gets written.
 */
export const chapterClass = (n) => `ch-${n}`;

/**
 * Emit the per-chapter custom properties as a stylesheet.
 *
 * Generated from `chapters` rather than hand-written in `styles.css` so the two
 * cannot fall out of sync. Because these cascade down from the slide element,
 * anything inside a slide -- including markdown content, which never sees a
 * component prop -- can just read `var(--chapter-accent)`.
 */
export const applyChapterStyles = () => {
  const css = chapters
    .map(({ n, accent }) => {
      // The 50-tints are chosen for a dark slide and vanish on white paper.
      // Darkening the saturated base keeps each chapter identifiable in a
      // handout without maintaining a second palette by hand.
      const text = isLightPrint
        ? `color-mix(in srgb, ${accent.base} 62%, #000)`
        : accent.text;

      return `.${chapterClass(n)} {
  --chapter-accent: ${text};
  --chapter-accent-base: ${accent.base};
}`;
    })
    .join("\n");

  const style = document.createElement("style");
  style.dataset.source = "chapters";
  style.textContent = css;
  document.head.appendChild(style);
};
