// Gets the demo tabs in the talk Chrome ready to present: the query typed, the model
// loaded, the chat cleared. Run by `talk:open` after it opens the tabs, and on its own
// between run-throughs:
//
//   npm run talk:ready       # needs `npm run cdp:talk`, with the demo tabs open
//
// SAFE TO RE-RUN. Each step checks first: a loaded model isn't reloaded, a clear chat
// isn't cleared. It drives each page's own UI (the buttons a person would click) rather
// than reaching into its state, so what it leaves is what a click would have.
//
// It only touches the demo tabs. The deck's own warm-ups (the Prompt API slide, one deck
// chat on LiteRT) are by hand.
//
// The demos load from their live sites, so with no network every step times out and
// says so. Nothing here fails `talk:open`: the deck still comes to the front.

import { fileURLToPath } from "node:url";

import { ENDPOINT, attach } from "../test/cdp.js";
import { pages } from "./talk-deck.mjs";

export const SEARCH_QUERY = "reducing bundle size with webpack";
export const WEB_AI_PROMPT = "In one sentence, what is bikeshedding?";

// How long a page has to show its controls, and wllama to load Gemma from the cache.
const PAGE_MS = 30_000;
const LOAD_MS = 180_000;

// Shared helpers, prepended to every step. Each step runs in the page as one async
// expression and returns a report, or throws with what it was waiting for.
const HELPERS = `
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const until = async (what, fn, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const found = fn();
      if (found) return found;
    }
    throw new Error("timed out waiting for " + what);
  };
  const button = (re) =>
    [...document.querySelectorAll("button")].find((b) => re.test(b.innerText.trim()));
  // React reads the native setter's value on the input event, not a plain assignment.
  const type = (el, value) => {
    const { set } = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
`;

const STEPS = [
  {
    id: "vector-search",
    match: (url) => url.pathname.startsWith("/vector-search-web/"),
    // Typed, not searched: the search is the demo.
    run: `
      const query = await until("the query box", () => document.querySelector("#query"), ${PAGE_MS});
      document.querySelector(".query-clear")?.click();
      await sleep(100);
      type(query, ${JSON.stringify(SEARCH_QUERY)});
      return { query: query.value };
    `,
  },
  {
    id: "web-ai",
    match: (url) => url.pathname.startsWith("/web-ai-demo/"),
    run: `
      const load = await until("the Load button", () => button(/^(Load|Loading…)$/), ${PAGE_MS});
      if (!load.disabled) load.click();
      await until("the model to load", () => {
        const now = button(/^(Load|Loading…)$/);
        return now && now.innerText.trim() === "Load" && now.disabled && button(/^Ask$/);
      }, ${LOAD_MS});
      const newChat = button(/^New chat$/);
      if (newChat && !newChat.disabled) newChat.click();
      await sleep(100);
      const prompt = document.querySelector('textarea[placeholder="Ask something…"]');
      type(prompt, ${JSON.stringify(WEB_AI_PROMPT)});
      // The deep link falls back to the default runtime on an id it doesn't know, so
      // report the runtime the page has selected, not the one the URL asked for.
      const runtime = document
        .querySelector(".picker-card--active")
        ?.innerText.split("\\n")[0];
      const model = new URLSearchParams(location.search).get("model");
      return { runtime, model, prompt: prompt.value };
    `,
  },
  {
    id: "web-agents",
    match: (url) => url.pathname.startsWith("/web-agents/"),
    run: `
      const input = await until("the chat box", () => document.querySelector("textarea.chat-input"), ${PAGE_MS});
      // An empty chat shows its suggestion chips in place of messages.
      const clear = () => !!document.querySelector(".chat-messages > .chat-suggestions");
      const wasClear = clear();
      if (!wasClear) {
        const fresh = button(/^(Clear notepad & start a new topic|Start fresh)$/);
        if (!fresh) throw new Error("a chat with no Start fresh button: reload the tab");
        fresh.click();
        await until("the chat to clear", clear, 2000);
      }
      type(input, "");
      return { cleared: !wasClear };
    `,
  },
];

const runStep = async (target, step) => {
  const session = await attach(target.webSocketDebuggerUrl);
  try {
    // A tab `talk:open` has just opened may still be on its first navigation, which
    // throws away the context an evaluation is running in. Wait for the real page first.
    for (let tries = 0; ; tries++) {
      const state = await session
        .eval(`location.href + " " + document.readyState`)
        .catch(() => "");
      if (
        state.endsWith(" complete") &&
        step.match(new URL(state.split(" ")[0]))
      )
        break;
      if (tries > PAGE_MS / 250)
        throw new Error("the page never finished loading");
      await new Promise((done) => setTimeout(done, 250));
    }
    const result = await session.send(
      "Runtime.evaluate",
      {
        expression: `(async () => { ${HELPERS} ${step.run} })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      PAGE_MS + LOAD_MS,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description?.split("\n")[0] ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  } finally {
    session.close();
  }
};

/** Readies every demo tab that's open. Returns true when all of them are. */
export const ready = async () => {
  const targets = (await pages()).filter((target) => {
    try {
      return new URL(target.url).hostname === "nearform.github.io";
    } catch {
      return false;
    }
  });
  const results = await Promise.all(
    STEPS.map(async (step) => {
      const target = targets.find((t) => step.match(new URL(t.url)));
      if (!target) return { step, error: "no tab open" };
      try {
        return { step, target, report: await runStep(target, step) };
      } catch (err) {
        return { step, target, error: err.message };
      }
    }),
  );
  for (const { step, report, error } of results) {
    if (error) console.error(`NOT READY ${step.id}: ${error}`);
    else console.log(`ready    ${step.id} ${JSON.stringify(report)}`);
  }
  return results.every((result) => !result.error);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await fetch(`${ENDPOINT}/json/version`);
  } catch {
    console.error(`no CDP at ${ENDPOINT} — run \`npm run cdp:talk\` first`);
    process.exit(1);
  }
  process.exit((await ready()) ? 0 : 1);
}
