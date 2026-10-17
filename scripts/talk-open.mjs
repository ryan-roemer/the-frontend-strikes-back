// Opens the talk in the talk Chrome as two windows: the deck with `?offline` alone in an
// app window (no tabs, no URL bar), and every demo in `deck/demos.js` (plus `EXTRA_TABS`) as
// tabs in a normal window. Brings the deck to the front last. See docs/offline.md.
//
//   npm run talk:open        # needs `npm run dev` and `npm run cdp:talk`
//
// SAFE TO RE-RUN. A tab already open at a demo's exact URL is left alone, and so is a
// `?offline` deck that has a window to itself. Any other deck tab is closed: the one
// `cdp:talk` opens has no flag, and presenting from it with no network leaves a blank
// deck; a flagged one sharing a window with the demos is from before the app window.
//
// The demos load from their live sites, so they need a network. The deck doesn't.
//
// Our own demos (the nearform.github.io ones) open with `?banner=false`, which drops
// the Nearform footer banner so the projector shows only the demo. web-agents also
// gets `?present=true`, which pins the AI-native engineering query in its suggestions.
//
// The tabs open in `TAB_ORDER`, not talk order: reebok, vector-search-web (the article
// search app), then the search tool's source on GitHub (from `EXTRA_TABS`, not a demo),
// the order "One tool, up close" shows them in.
//
// CDP CAN'T OPEN AN APP WINDOW, so `cdp:talk` starts the talk Chrome with `--app` on the
// deck. If that window is gone, this tries `open -na "Google Chrome" --args --app=…` on
// the talk profile; when that doesn't reach the running talk Chrome (on 2026-10-16 it
// didn't), it says to restart it. Everything else is plain CDP HTTP (`/json/*`), plus
// one browser-level call to see which window a deck tab is in.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ENDPOINT } from "../test/cdp.js";
import { DEMO_LINKS } from "../deck/demos.js";
import {
  DECK,
  deckUrl,
  deckWindows,
  isOfflineDeck,
  pages,
} from "./talk-deck.mjs";

// The `--user-data-dir` from `cdp:talk` in package.json. Keep the two in step.
const PROFILE =
  process.env.TALK_PROFILE ?? join(homedir(), ".cache/tfsb-chrome-talk");

const PRESENT_DEMOS = new Set(["web-agents"]);

// Tabs that aren't demos, so they stay out of `DEMO_LINKS` and off the slides.
const EXTRA_TABS = {
  "search-tool-source":
    "https://github.com/nearform/vector-search-web/blob/ab4d3bd0bfcb55475b1532cf7b2b1518492e056c/public/app/data/tools/search.js#L7-L71",
};

const LINKS = { ...DEMO_LINKS, ...EXTRA_TABS };

// Ids missing here open after these, in `LINKS` order.
const TAB_ORDER = ["chatgpt-desktop", "vector-search", "search-tool-source"];

const forTalk = (id, href) => {
  const url = new URL(href);
  if (url.hostname !== "nearform.github.io") return href;
  url.searchParams.set("banner", "false");
  if (PRESENT_DEMOS.has(id)) url.searchParams.set("present", "true");
  return url.href;
};

const open = async (href) => {
  // Encoded, or Chrome cuts the URL off at its first `&`.
  const res = await fetch(`${ENDPOINT}/json/new?${encodeURIComponent(href)}`, {
    method: "PUT",
  });
  if (!res.ok)
    throw new Error(`Chrome refused a new tab for ${href} (${res.status})`);
  return res.json();
};

const close = (target) => fetch(`${ENDPOINT}/json/close/${target.id}`);

try {
  await fetch(`${ENDPOINT}/json/version`);
} catch {
  console.error(`no CDP at ${ENDPOINT} — run \`npm run cdp:talk\` first`);
  process.exit(1);
}

try {
  await fetch(DECK, { method: "HEAD" });
} catch {
  console.error(`nothing serving ${DECK.href} — run \`npm run dev\` first`);
  process.exit(1);
}

// Demos first, so the normal window exists before any deck tab in it is closed.
const ids = [
  ...TAB_ORDER.filter((id) => id in LINKS),
  ...Object.keys(LINKS).filter((id) => !TAB_ORDER.includes(id)),
];
// Two demos can share a page, so a link opened earlier in this loop is kept too.
const opened = new Set((await pages()).map((target) => target.url));
for (const id of ids) {
  const href = forTalk(id, LINKS[id]);
  if (opened.has(href)) {
    console.log(`kept     ${href} (${id})`);
  } else {
    await open(href);
    opened.add(href);
    console.log(`opened   ${href} (${id})`);
  }
}

const { all, decks, deck: kept } = await deckWindows();
let deck = kept;
if (deck) {
  console.log(`kept     ${deck.url} (own window)`);
} else {
  // Only a fallback: `cdp:talk` starts the talk Chrome with this window already open.
  await promisify(execFile)("open", [
    "-na",
    "Google Chrome",
    "--args",
    `--user-data-dir=${PROFILE}`,
    `--app=${deckUrl}`,
  ]);
  const known = new Set(all.map((target) => target.id));
  for (let tries = 0; !deck && tries < 50; tries++) {
    await new Promise((done) => setTimeout(done, 200));
    deck = (await pages()).find(
      (target) => !known.has(target.id) && isOfflineDeck(new URL(target.url)),
    );
  }
  if (!deck) {
    // The old deck tabs stay open, so there is still something to present from.
    console.error(
      `no deck app window. Quit the talk Chrome (pkill -f tfsb-chrome-talk), then run \`npm run cdp:talk\`, which opens it, and this again.`,
    );
    process.exit(1);
  }
  console.log(`opened   ${deckUrl} (app window)`);
}

// Closed only once the app window is up, so a failed launch never leaves no deck.
for (const target of decks) {
  if (target.id === deck.id) continue;
  await close(target);
  const why = isOfflineDeck(new URL(target.url))
    ? "not in its own window"
    : "no ?offline";
  console.log(`closed   ${target.url} (${why})`);
}

await fetch(`${ENDPOINT}/json/activate/${deck.id}`);
process.exit(0);
