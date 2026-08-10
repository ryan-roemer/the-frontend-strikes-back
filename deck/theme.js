/* global document:false,window:false,URLSearchParams:false */

// --- Render modes -----------------------------------------------------------
//
// Spectacle renders every slide stacked for both `?printMode=true` and
// `?exportMode=true`, but swaps to its light, ink-saving palette only for
// `printMode && !exportMode` (see `printMode: s && !c` in the Deck). The two
// modes want opposite things from this design:
//
//   exportMode  -- a PDF that looks like the talk. Keep the deck dark.
//   printMode   -- a paper handout. Go light, or the deck's grey-on-navy print
//                  palette is unreadable and burns a cartridge doing it.
const params = new URLSearchParams(window.location.search);
const exportMode = params.get("exportMode") === "true";

/** Slides are stacked for paged output (either mode). */
const isPaged = exportMode || params.get("printMode") === "true";

/** Paper handout: Spectacle has switched to its light palette. */
export const isLightPrint = isPaged && !exportMode;

// Nearform color palette
// NOTE: Use these colors through Spectacle component props (color="primary")
// rather than inline styles (style={{color: theme.colors.primary}})
export const colors = {
  basics: {
    white: "#fff",
    black: "#000",
  },
  midnight: {
    base: "#000E38",
    80: "#0C3D60",
    50: "#526288",
    30: "#97A1B8",
    10: "#F4F8FA",
  },
  green: {
    base: "#00E5A4",
    80: "#33EAAE",
    50: "#78EEC5",
    30: "#B2F7E1",
    10: "#E5FCF5",
  },
  purple: {
    base: "#8950FF",
    80: "#A173FF",
    50: "#C4A7FF",
    30: "#DCCAFF",
    10: "#F3EDFF",
  },
  blue: {
    base: "#166bff",
    80: "#4589FF",
    50: "#8AB5FF",
    30: "#B9D3FF",
    10: "#E8F0FF",
  },
  grey: {
    10: "#EAEBED",
    30: "#D9D9D9",
    80: "#454551",
  },
  red: {
    base: "#FF6B6B",
    80: "#FF8F8F",
    50: "#FFB3B3",
    30: "#FFD7D7",
    10: "#FFEFEF",
  },
};

// Nearform theme
//
// Sizes are absolute px because Spectacle renders onto a fixed 1366x768 canvas
// and scales the whole thing, so px stay predictable at any projector size.
export const theme = {
  colors: {
    primary: colors.basics.white,
    secondary: colors.green[50], // headings
    tertiary: colors.midnight[80], // background
    quaternary: colors.blue[30], // links
    quinary: colors.grey[10],
  },
  fonts: {
    header: "'Inter', system-ui, sans-serif",
    text: "'Inter', system-ui, sans-serif",
    monospace: "'Fira Code', ui-monospace, SFMono-Regular, Consolas, monospace",
  },
  // A ~1.27 modular scale. Spectacle's defaults (72/64/56/44) step by only
  // 1.13-1.27, so h1 through h3 read as one size and the hierarchy collapses.
  //
  // The floor matters as much as the ratio: this renders onto a fixed 1366x768
  // canvas that gets read from the back of a room, so `text` cannot chase the
  // scale downward. Every step here is sized to survive that projection.
  //
  // Deep-merged with the default theme, so anything omitted here is untouched.
  fontSizes: {
    h1: "72px",
    h2: "58px",
    h3: "46px",
    text: "36px",
    // Read by CodePane and by inline CodeSpan. 18px is what fits the longest
    // example (`tool-handler.js`, 31 lines) on the 768px canvas.
    monospace: "18px",
  },
  space: [16, 28, 44],
};

// --- Slide background -------------------------------------------------------
//
// Spectacle paints a Slide's background onto a `::before` pseudo-element, and
// `backgroundImage` is a real styled-system prop -- so depth and vignette are
// just stacked gradient layers. No extra DOM, no CSS hack.
//
// `Deck` passes its own `backgroundImage` down as the fallback for any slide
// that doesn't set one, so this single prop reaches every slide -- including
// the markdown sets, which never see a per-slide prop. Layers are top-most
// first, and every layer here is `cover`, which matches Spectacle's per-slide
// `backgroundSize` default (the deck context does not carry size or repeat).
//
// The film grain that sits on top of this is a CSS overlay in `styles.css`,
// since it needs to tile rather than cover.

const VIGNETTE =
  "radial-gradient(120% 120% at 50% 35%, rgba(0,14,56,0) 42%, rgba(0,14,56,0.55) 100%)";

// Light source sits off the top-left corner and falls away to deep midnight.
const DEPTH =
  "radial-gradient(115% 95% at 12% -10%, #12507C 0%, #0C3D60 38%, #04203F 72%, #000E38 100%)";

// Omitted for the paper handout, where it would paint navy over Spectacle's
// light print palette and leave grey text on a dark field.
export const DECK_BACKGROUND = isLightPrint
  ? undefined
  : `${VIGNETTE}, ${DEPTH}`;

/**
 * Background props for a full-bleed photo slide.
 *
 * The dimming is baked into gradient layers rather than using Spectacle's
 * `backgroundOpacity`, which fades the *entire* pseudo-element uniformly. As a
 * scrim instead, contrast stays directional -- dark where the text sits, open
 * where it doesn't -- so headings stay legible over any photo, and the image
 * keeps its own contrast instead of washing out to grey.
 */
export const photoBackground = (url) =>
  isLightPrint
    ? // On paper the photo is a full-bleed ink flood that would also strand
      // Spectacle's dark print text on top of it. Dividers print as plain
      // slides; the chapter numeral and accent rule still mark the section.
      {}
    : {
        backgroundImage: [
          // Tuned against the brightest photo in the set (`danger`), so the
          // title area lands in the same tonal range whatever the image.
          "linear-gradient(100deg, rgba(0,14,56,0.96) 0%, rgba(0,14,56,0.88) 42%, rgba(0,14,56,0.62) 100%)",
          "linear-gradient(0deg, rgba(0,14,56,0.88) 0%, rgba(0,14,56,0.25) 60%)",
          `url(${url})`,
        ].join(", "),
        backgroundColor: colors.basics.black,
      };

// --- CSS custom properties --------------------------------------------------

/**
 * Mirror the palette onto :root as `--nf-*` custom properties.
 *
 * Keeps `styles.css` from re-hardcoding hexes that already live here. Runs at
 * import time; custom properties are live, so applying them after the
 * stylesheet has parsed is fine.
 */
const applyCssVars = () => {
  const root = document.documentElement;

  Object.entries(colors).forEach(([family, ramp]) => {
    Object.entries(ramp).forEach(([stop, value]) => {
      root.style.setProperty(`--nf-${family}-${stop}`, value);
    });
  });

  Object.entries(theme.colors).forEach(([name, value]) => {
    root.style.setProperty(`--nf-${name}`, value);
  });

  // Render-mode hooks for styles.css. Paged output has no viewport chrome and
  // no hover, and the handout needs ink-on-white treatments throughout.
  if (isPaged) root.classList.add("paged-mode");
  if (isLightPrint) root.classList.add("print-mode");
};

applyCssVars();
