// Generates `images/qr-code.svg`: the talk URL as a QR code in the deck palette,
// with Nearform's `N_` mark knocked out of the middle.
//
//   node scripts/gen-qr.mjs
//
// Two things keep this scannable rather than just pretty:
//
//   * Error correction level H recovers ~30% of a damaged symbol, which is what
//     buys the space for the center logo. The knockout below is ~7% of the area,
//     so there is a wide margin left over for a bad camera angle or a glare
//     streak off the projector screen.
//   * Only the *dark* modules get brand color, and only in colors dark enough to
//     hold contrast against white. Nearform's signature `#00E5A4` is far too
//     light to encode with -- it appears on the underscore in the logo, where
//     nothing is being read, and nowhere else.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const URL_TO_ENCODE =
  "https://ryan-roemer.github.io/the-frontend-strikes-back/";
const OUT = resolve(ROOT, "images/qr-code.svg");

const COLORS = {
  /** Data modules. Nearform midnight. */
  data: "#000E38",
  /** The three finder patterns -- the deck's accent, darkened enough to scan. */
  finder: "#07A06F",
  /** Card behind the code. Must stay light for the contrast to work. */
  card: "#ffffff",
  /** The `N` of the logo mark. */
  logoInk: "#000E38",
  /** The `_` of the logo mark. Nearform green, at full strength. */
  logoAccent: "#00E5A4",
};

/**
 * Blank modules around the symbol, which is how a scanner finds its edges.
 *
 * The spec asks for 4. Two is safe here only because `.qr-card` in
 * `deck/styles.css` wraps this in 12px of white padding, worth roughly another
 * 3.5 modules at the size the title slide renders it -- so the code still sits
 * in more than 4 modules of white, and the symbol itself gets to be bigger.
 * Drop the card padding and this needs to go back to 4.
 */
const QUIET = 2;

/** Corner radius of the white card, in modules. */
const CARD_RADIUS = 2;

/**
 * How much of its cell each data module fills. Below 1 it leaves a hairline of
 * white on every side, which is what puts visible air around the finder
 * patterns and the logo knockout.
 *
 * This is the only safe way to open up those gaps. The obvious alternative --
 * shrinking the finder patterns, or clearing an extra ring of modules around
 * them -- does not work:
 *
 *   * A scanner derives the module pitch for the whole symbol from the
 *     finder's 1:1:3:1:1 run lengths, so drawing the eye even 5% small throws
 *     off its grid sampling and the code stops decoding. Verified: at
 *     FINDER_SCALE 0.95 this file no longer reads.
 *   * The ring just outside each finder's 1-module separator is format
 *     information, not data. It says which mask and error correction level the
 *     symbol uses, and error correction cannot recover it. Clearing it to make
 *     room is worse than clearing anything else in the symbol.
 *
 * So the finders stay exactly 7 modules, the separator stays exactly 1, and the
 * gap gets its extra width from the data side.
 *
 * 0.9 is as small as this goes. Below it the white gaps start reading as real
 * structure to a decoder at high resolution: 0.86 decodes fine at 150px and
 * 300px and fails at 800px. If you change this, check the result at several
 * pixel sizes and not just the one the slide renders -- a value that scans fine
 * on the projector can still fail on a printed handout.
 */
const MODULE_SIZE = 0.9;

/**
 * Module corner rounding, as a fraction of one module (0 = square, 0.5 = a dot).
 * Anything above ~0.35 starts eating enough of each module's area to cost
 * contrast on a low-resolution camera.
 */
const MODULE_ROUND = 0.3;

/** Width of the logo knockout, in modules. Odd, so it centers on a module. */
const LOGO_MODULES = 13;

/** Padding between the edge of the knockout and the mark itself, in modules. */
const LOGO_INSET = 2.0;

// --- Nearform `N_` mark -----------------------------------------------------
//
// Lifted from nearform.com's favicon, whose viewBox is `0 0 64 64`. The white
// path in the original is an offset copy sitting behind the green underscore;
// it only exists to separate the two on a colored background, and on this
// white card it would be invisible, so it is dropped.
const LOGO = {
  // Tight bounding box of the two paths kept below, in the source viewBox.
  box: { x: 5.52, y: 11.05, w: 52.96, h: 41.72 },
  paths: [
    {
      fill: COLORS.logoInk,
      d: "M5.52,11.05h5.46l17.72,25.77V11.05h5.87v36.37h-5.46L11.39,21.65v25.77h-5.87V11.05Z",
    },
    { fill: COLORS.logoAccent, d: "M38.06,47.42h20.42v5.35h-20.42v-5.35Z" },
  ],
};

// --- Symbol -----------------------------------------------------------------

const qr = QRCode.create(URL_TO_ENCODE, { errorCorrectionLevel: "H" });
const size = qr.modules.size;
const { data } = qr.modules;

const isDark = (row, col) => data[row * size + col] === 1;

/**
 * True for the 7x7 blocks in three corners. These are what a scanner locks onto
 * first, so they are drawn as one continuous shape rather than as loose modules.
 */
const inFinder = (row, col) =>
  (row < 7 && col < 7) ||
  (row < 7 && col >= size - 7) ||
  (row >= size - 7 && col < 7);

/** True for modules the logo sits on top of, which are left undrawn. */
const half = (LOGO_MODULES - 1) / 2;
const mid = (size - 1) / 2;
const underLogo = (row, col) =>
  Math.abs(row - mid) <= half && Math.abs(col - mid) <= half;

// --- SVG --------------------------------------------------------------------

const board = size + QUIET * 2;
const px = (n) => Number(n.toFixed(3));

/**
 * One finder pattern: an outer ring and a solid center, both rounded.
 *
 * Drawn at exactly 7x7 modules with 1-module ring, 1-module gap, 3-module
 * center. Do not scale this -- see `MODULE_SIZE`. Rounding the corners is fine
 * because it leaves the ratio along the horizontal and vertical center lines,
 * which is what gets measured, untouched.
 */
const finder = (row, col) => {
  const x = QUIET + col;
  const y = QUIET + row;
  return [
    // Outer ring, drawn as a rounded square with a rounded square punched out.
    `<path fill="${COLORS.finder}" fill-rule="evenodd" d="${[
      roundedRect(x, y, 7, 7, 1.75),
      roundedRect(x + 1, y + 1, 5, 5, 1.15),
    ].join(" ")}"/>`,
    `<rect fill="${COLORS.finder}" x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.75"/>`,
  ].join("\n  ");
};

/** A rounded rectangle as a standalone subpath, for use inside `fill-rule`. */
const roundedRect = (x, y, w, h, r) =>
  `M${px(x + r)},${px(y)}h${px(w - r * 2)}a${px(r)},${px(r)} 0 0 1 ${px(r)},${px(r)}` +
  `v${px(h - r * 2)}a${px(r)},${px(r)} 0 0 1 ${px(-r)},${px(r)}` +
  `h${px(-(w - r * 2))}a${px(r)},${px(r)} 0 0 1 ${px(-r)},${px(-r)}` +
  `v${px(-(h - r * 2))}a${px(r)},${px(r)} 0 0 1 ${px(r)},${px(-r)}z`;

const modules = [];
for (let row = 0; row < size; row++) {
  for (let col = 0; col < size; col++) {
    if (!isDark(row, col) || inFinder(row, col) || underLogo(row, col))
      continue;
    // Row 6 and column 6 are the timing patterns: a dead-straight alternating
    // run that a scanner counts to work out how many modules wide the symbol is.
    // Shrinking those turns a 1:1 alternation into 0.86:1.14 and the count comes
    // out wrong, so they are drawn full-bleed and only the rest gets the gap.
    const full = row === 6 || col === 6;
    const w = full ? 1 : MODULE_SIZE;
    const offset = (1 - w) / 2;
    modules.push(
      `<rect x="${px(QUIET + col + offset)}" y="${px(QUIET + row + offset)}" width="${w}" height="${w}" rx="${px(MODULE_ROUND * w)}"/>`,
    );
  }
}

// Scale the mark to fit the knockout, preserving its aspect ratio, and center it.
const slot = LOGO_MODULES - LOGO_INSET * 2;
const scale = Math.min(slot / LOGO.box.w, slot / LOGO.box.h);
const logoX = (board - LOGO.box.w * scale) / 2 - LOGO.box.x * scale;
const logoY = (board - LOGO.box.h * scale) / 2 - LOGO.box.y * scale;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/gen-qr.mjs. Edit that, not this.
     Encodes ${URL_TO_ENCODE}
     NOTE: no double hyphens in here. XML forbids them inside a comment, and
     Chrome refuses to parse the whole file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${board} ${board}" width="${board * 8}" height="${board * 8}" role="img" aria-label="QR code linking to ${URL_TO_ENCODE}">
  <rect width="${board}" height="${board}" rx="${CARD_RADIUS}" fill="${COLORS.card}"/>
  <g fill="${COLORS.data}" shape-rendering="geometricPrecision">
    ${modules.join("\n    ")}
  </g>
  ${finder(0, 0)}
  ${finder(0, size - 7)}
  ${finder(size - 7, 0)}
  <g transform="translate(${px(logoX)} ${px(logoY)}) scale(${px(scale)})">
    ${LOGO.paths.map((p) => `<path fill="${p.fill}" d="${p.d}"/>`).join("\n    ")}
  </g>
</svg>
`;

writeFileSync(OUT, svg);
console.log(
  `Wrote ${OUT}\n  url: ${URL_TO_ENCODE}\n  version ${qr.version}, ECC H, ${size}x${size} modules\n  logo covers ${LOGO_MODULES}x${LOGO_MODULES} (${((LOGO_MODULES ** 2 / size ** 2) * 100).toFixed(1)}% of the symbol)`,
);
