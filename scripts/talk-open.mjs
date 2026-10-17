// Opens the talk in the talk Chrome as two windows: the deck with `?offline` alone in an
// app window (no tabs, no URL bar), and every demo in `deck/demos.js` as tabs in a normal
// window. Brings the deck to the front last. See docs/offline.md.
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
// The tabs open in `TAB_ORDER`, not talk order: vector-search-web first, then reebok.
//
// CDP CAN'T OPEN AN APP WINDOW, so the deck goes through `open -na "Google Chrome" --args
// --app=…` with the talk profile's `--user-data-dir`. Chrome hands that to the talk
// Chrome already running on the profile instead of starting a second one. Everything
// else is plain CDP HTTP (`/json/*`), plus one browser-level call to see which window a
// deck tab is in.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ENDPOINT, attach } from "../test/cdp.js";
import { DEMO_LINKS } from "../deck/demos.js";

const DECK = new URL(process.env.DECK_URL ?? "http://localhost:3000/");
const deckUrl = new URL("?offline", DECK).href;

// The `--user-data-dir` from `cdp:talk` in package.json. Keep the two in step.
const PROFILE =
  process.env.TALK_PROFILE ?? join(homedir(), ".cache/tfsb-chrome-talk");

// The presenter view (`?presenterMode=true`, on its own screen) is left alone.
const isDeck = (url) =>
  url.origin === DECK.origin && !url.searchParams.has("presenterMode");
const isOfflineDeck = (url) => isDeck(url) && url.searchParams.has("offline");

const PRESENT_DEMOS = new Set(["web-agents"]);

// Demo ids missing here open after these, in `DEMO_LINKS` order.
const TAB_ORDER = ["vector-search", "chatgpt-desktop"];

const forTalk = (id, href) => {
  const url = new URL(href);
  if (url.hostname !== "nearform.github.io") return href;
  url.searchParams.set("banner", "false");
  if (PRESENT_DEMOS.has(id)) url.searchParams.set("present", "true");
  return url.href;
};

const pages = async () => {
  const targets = await (await fetch(`${ENDPOINT}/json/list`)).json();
  return targets.filter((target) => target.type === "page");
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

let version;
try {
  version = await (await fetch(`${ENDPOINT}/json/version`)).json();
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
  ...TAB_ORDER.filter((id) => id in DEMO_LINKS),
  ...Object.keys(DEMO_LINKS).filter((id) => !TAB_ORDER.includes(id)),
];
// Two demos can share a page, so a link opened earlier in this loop is kept too.
const opened = new Set((await pages()).map((target) => target.url));
for (const id of ids) {
  const href = forTalk(id, DEMO_LINKS[id]);
  if (opened.has(href)) {
    console.log(`kept     ${href} (${id})`);
  } else {
    await open(href);
    opened.add(href);
    console.log(`opened   ${href} (${id})`);
  }
}

const browser = await attach(version.webSocketDebuggerUrl);
const windowOf = async (target) =>
  (await browser.send("Browser.getWindowForTarget", { targetId: target.id }))
    .windowId;

const all = await pages();
const windows = new Map();
for (const target of all) windows.set(target.id, await windowOf(target));
const alone = (target) =>
  all.filter((other) => windows.get(other.id) === windows.get(target.id))
    .length === 1;

let deck;
for (const target of all) {
  const url = new URL(target.url);
  if (!isDeck(url)) continue;
  if (!deck && isOfflineDeck(url) && alone(target)) {
    deck = target;
    console.log(`kept     ${target.url} (own window)`);
  } else {
    await close(target);
    const why = !isOfflineDeck(url)
      ? "no ?offline"
      : deck
        ? "a second deck"
        : "in the demo window";
    console.log(`closed   ${target.url} (${why})`);
  }
}

if (!deck) {
  await promisify(execFile)("open", [
    "-na",
    "Google Chrome",
    "--args",
    `--user-data-dir=${PROFILE}`,
    `--app=${deckUrl}`,
  ]);
  for (let tries = 0; !deck && tries < 50; tries++) {
    await new Promise((done) => setTimeout(done, 200));
    deck = (await pages()).find((target) => isOfflineDeck(new URL(target.url)));
  }
  if (!deck) {
    console.error(
      `no deck window after \`open --app=${deckUrl}\`. Is the talk Chrome on ${PROFILE}?`,
    );
    process.exit(1);
  }
  console.log(`opened   ${deckUrl} (app window)`);
}

await fetch(`${ENDPOINT}/json/activate/${deck.id}`);
process.exit(0);
