/* global document:false */
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

export const chapters = [
  {
    n: 1,
    title: "Agents are already here",
    accent: ACCENTS.darkGreen,
    background: backgrounds.danger,
  },
  {
    n: 2,
    title: "WebMCP",
    accent: ACCENTS.purple,
    background: backgrounds.networkCables,
  },
  {
    n: 3,
    title: "The basics",
    accent: ACCENTS.green,
    background: backgrounds.greenCode,
  },
  {
    n: 4,
    title: "Demo: Claude Desktop",
    accent: ACCENTS.blue,
    background: backgrounds.oldComputer,
  },
  {
    n: 5,
    title: "All in the browser",
    accent: ACCENTS.purple,
    background: backgrounds.bookStacks,
  },
  {
    n: 6,
    title: "Stumbling blocks & hacks",
    accent: ACCENTS.darkGreen,
    background: backgrounds.cuttingBoard,
  },
  {
    n: 7,
    title: "Start building today",
    accent: ACCENTS.green,
    background: backgrounds.mopop,
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
