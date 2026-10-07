// Opens the talk's tabs in the talk Chrome: the deck with `?offline`, then every demo
// in `deck/demos.js` in talk order, and brings the deck tab to the front. See
// docs/offline.md.
//
//   npm run talk:open        # needs `npm run dev` and `npm run cdp:talk`
//
// SAFE TO RE-RUN. A tab already open at a demo's exact URL is left alone, and so is a
// deck tab that has the `?offline` flag. A deck tab WITHOUT the flag is closed:
// `cdp:talk` opens one, and presenting from it with no network leaves a blank deck.
//
// The demos load from their live sites, so they need a network. The deck doesn't.
//
// Over plain CDP HTTP (`/json/*`), no websocket: opening, listing, closing and
// activating tabs is all this needs.

import { ENDPOINT } from "../test/cdp.js";
import { DEMO_LINKS } from "../deck/demos.js";

const DECK = new URL(process.env.DECK_URL ?? "http://localhost:3000/");
const deckUrl = new URL("?offline", DECK).href;

const isDeck = (url) => url.origin === DECK.origin;

const pages = async () => {
  const targets = await (await fetch(`${ENDPOINT}/json/list`)).json();
  return targets.filter((target) => target.type === "page");
};

const open = async (href) => {
  const res = await fetch(`${ENDPOINT}/json/new?${href}`, { method: "PUT" });
  if (!res.ok)
    throw new Error(`Chrome refused a new tab for ${href} (${res.status})`);
  return res.json();
};

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

const before = await pages();

for (const target of before) {
  const url = new URL(target.url);
  if (isDeck(url) && !url.searchParams.has("offline")) {
    await fetch(`${ENDPOINT}/json/close/${target.id}`);
    console.log(`closed   ${target.url} (no ?offline)`);
  }
}

let deck = before.find((target) => {
  const url = new URL(target.url);
  return isDeck(url) && url.searchParams.has("offline");
});
if (deck) {
  console.log(`kept     ${deck.url}`);
} else {
  deck = await open(deckUrl);
  console.log(`opened   ${deckUrl}`);
}

for (const [id, href] of Object.entries(DEMO_LINKS)) {
  if (before.some((target) => target.url === href)) {
    console.log(`kept     ${href} (${id})`);
  } else {
    await open(href);
    console.log(`opened   ${href} (${id})`);
  }
}

await fetch(`${ENDPOINT}/json/activate/${deck.id}`);
