// Finds the deck's app window in the talk Chrome. Imported by `talk-open.mjs`, and run
// on its own by `cdp:talk` when the talk Chrome is already up:
//
//   node scripts/talk-deck.mjs    # exits 1, saying what to do, if the window is gone
//
// The window is gone if you close it. On macOS that leaves Chrome running with no
// windows, so `cdp:talk` would otherwise just say "already running" and open nothing.
// It can't reopen it either: CDP has no app windows, and `open --app` doesn't reach a
// running talk Chrome (tried 2026-10-16). Quitting it and running `cdp:talk` again does.

import { fileURLToPath } from "node:url";

import { ENDPOINT, attach } from "../test/cdp.js";

export const DECK = new URL(process.env.DECK_URL ?? "http://localhost:3000/");
export const deckUrl = new URL("?offline", DECK).href;

// The presenter view (`?presenterMode=true`, on its own screen) is left alone.
export const isDeck = (url) =>
  url.origin === DECK.origin && !url.searchParams.has("presenterMode");
export const isOfflineDeck = (url) =>
  isDeck(url) && url.searchParams.has("offline");

export const pages = async () => {
  const targets = await (await fetch(`${ENDPOINT}/json/list`)).json();
  return targets.filter((target) => target.type === "page");
};

/**
 * Every page, the deck tabs among them, and the `?offline` deck that has a window to
 * itself (the app window), if there is one.
 */
export const deckWindows = async () => {
  const { webSocketDebuggerUrl } = await (
    await fetch(`${ENDPOINT}/json/version`)
  ).json();
  const browser = await attach(webSocketDebuggerUrl);
  const all = await pages();
  const windows = new Map();
  for (const target of all) {
    const { windowId } = await browser.send("Browser.getWindowForTarget", {
      targetId: target.id,
    });
    windows.set(target.id, windowId);
  }
  const alone = (target) =>
    all.filter((other) => windows.get(other.id) === windows.get(target.id))
      .length === 1;
  const decks = all.filter((target) => isDeck(new URL(target.url)));
  const deck = decks.find(
    (target) => isOfflineDeck(new URL(target.url)) && alone(target),
  );
  return { all, decks, deck };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { deck } = await deckWindows();
  if (!deck) {
    console.error(
      "the talk Chrome is running, but its deck window is gone. Quit it (Cmd+Q, or pkill -f tfsb-chrome-talk) and run this again.",
    );
    process.exit(1);
  }
  console.log(`deck window open at ${deck.url}`);
  process.exit(0);
}
