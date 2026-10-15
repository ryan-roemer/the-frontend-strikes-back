// Prints the deck's `?exportMode=true` view to `the-frontend-strikes-back.pdf` in the
// repo root: the dark, talk-looking PDF, one slide per page.
//
//   npm run pdf          # localhost; needs `npm run dev` and `npm run cdp`
//   npm run pdf:prod     # the GitHub Pages deck; needs `npm run cdp`
//
// Same as printing that view from Chrome with no margins and background graphics on,
// except the page is sized to the slide instead of Letter, so nothing is letterboxed.
// The size is read from the rendered slide rather than hard-coded, so it follows the
// deck if Spectacle's canvas ever changes.
//
// Opens its own tab in the CDP Chrome and closes it afterwards.

import { writeFile } from "node:fs/promises";
import { attach, ENDPOINT } from "../test/cdp.js";

const OUT = new URL("../the-frontend-strikes-back.pdf", import.meta.url);

const deck = new URL(
  process.argv[2] ?? process.env.DECK_URL ?? "http://localhost:3000/",
);
deck.searchParams.set("exportMode", "true");

/** How long to wait for every slide, font and image to arrive. Prod pulls from CDNs. */
const READY_MS = 30000;

/** Printing all the slides is one call, and much slower than any other CDP call. */
const PRINT_MS = 120000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Spectacle's export view puts a page break after every slide, so those are the slides.
// Ready means fonts loaded, images loaded, and the same slide count two polls running.
const MEASURE = `(async () => {
  await document.fonts.ready;
  const slides = [...document.querySelectorAll("body *")].filter(
    (el) => getComputedStyle(el).breakAfter === "page",
  );
  const first = slides[0];
  return {
    count: slides.length,
    imagesDone: [...document.images].every((img) => img.complete),
    width: first?.offsetWidth ?? 0,
    height: first?.offsetHeight ?? 0,
  };
})()`;

const waitForSlides = async (session) => {
  const deadline = Date.now() + READY_MS;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(500);
    const now = await session.eval(MEASURE).catch(() => null);
    if (
      now?.count > 0 &&
      now.imagesDone &&
      now.count === last?.count &&
      now.height === last?.height
    )
      return now;
    last = now;
  }
  return null;
};

try {
  await fetch(`${ENDPOINT}/json/version`);
} catch {
  console.error(
    `no CDP at ${ENDPOINT} — run \`npm run cdp\` first, or point CDP_URL at a Chrome`,
  );
  process.exit(1);
}

try {
  await fetch(deck, { method: "HEAD" });
} catch {
  console.error(
    deck.hostname === "localhost"
      ? `nothing serving ${deck.origin} — run \`npm run dev\` first`
      : `cannot reach ${deck.origin}`,
  );
  process.exit(1);
}

// Encoded, or Chrome cuts the URL off at its first `&`.
const target = await (
  await fetch(`${ENDPOINT}/json/new?${encodeURIComponent(deck.href)}`, {
    method: "PUT",
  })
).json();
const session = await attach(target.webSocketDebuggerUrl);

try {
  const slides = await waitForSlides(session);
  if (!slides) {
    console.error(`${deck.href} did not settle within ${READY_MS}ms`);
    process.exitCode = 1;
  } else {
    // CDP paper sizes are inches, at CSS's 96px to the inch.
    const { data } = await session.send(
      "Page.printToPDF",
      {
        printBackground: true,
        paperWidth: slides.width / 96,
        paperHeight: slides.height / 96,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      },
      PRINT_MS,
    );
    await writeFile(OUT, Buffer.from(data, "base64"));
    console.log(
      `wrote ${OUT.pathname} (${slides.count} slides, ${slides.width}x${slides.height}) from ${deck.href}`,
    );
  }
} finally {
  session.close();
  await fetch(`${ENDPOINT}/json/close/${target.id}`, { method: "PUT" }).catch(
    () => {},
  );
}
