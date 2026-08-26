/**
 * Just enough Chrome DevTools Protocol to run a fixture against the deck.
 *
 * NO DEPENDENCIES, ON PURPOSE. Node 22+ has a global `WebSocket`, and everything below is
 * two HTTP calls and one socket. Puppeteer would be ~150MB and a second Chrome to keep this
 * file at eighty lines -- and this repo's whole claim is a short dependency list that
 * `docs/dependencies.md` accounts for line by line.
 *
 * ATTACHES TO A RUNNING BROWSER RATHER THAN LAUNCHING ONE, and OPENS ITS OWN TAB if the
 * deck is not already up. The only thing a person has to arrange is a Chrome with
 * `--remote-debugging-port=9222` and `npm run dev`; requiring them to also open the right
 * URL with the right flag was a step to get wrong before the tests could even run.
 *
 * REUSES A DECK TAB WHEN THERE IS ONE, which is what makes the debug loop quick: leave the
 * deck open, edit a fixture, re-run, and watch the slides change while it goes. A tab this
 * module opened is closed again afterwards; a tab it found is left exactly as it was.
 *
 * NOT LAUNCHING CHROME IS DELIBERATE. The deck's real provider downloads ~2GB of model
 * weights into a Cache entry, so a throwaway profile per run would be either enormous or
 * useless. The replay provider needs none of that -- but the browser is still the user's,
 * and a test suite that spawns and kills their browser is a worse trade than one that
 * skips.
 */

const ENDPOINT = process.env.CDP_URL ?? "http://127.0.0.1:9222";

/** Where the deck is served. `npm run dev` is `npx serve`, which defaults to :3000. */
const DECK = process.env.DECK_URL ?? "http://localhost:3000/";

/** How long to give the deck to mount. It pulls React and Spectacle from a CDN. */
const READY_MS = 20000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The deck URL with the harness turned on.
 *
 * `replay=1` RATHER THAN A BARE `?replay`, because this has to survive `URL` normalising
 * whatever `DECK_URL` was set to. `chat/url.js` `flag()` accepts both, and the deck appends
 * its own `slideIndex`/`stepIndex` afterwards either way.
 */
const deckUrl = () => {
  const url = new URL(DECK);
  url.searchParams.set("replay", "1");
  // `?safe` unregisters the editing tools this exists to exercise. Never inherited, even
  // if somebody put it in DECK_URL.
  url.searchParams.delete("safe");
  return url.toString();
};

/**
 * One CDP session over one socket.
 *
 * SEQUENTIAL IDS AND A PENDING MAP, because CDP replies arrive out of order and the id is
 * the only thing tying one to its call. Small enough not to need a library, and specific
 * enough that a library would hide it.
 */
const attach = (url) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let id = 0;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });

    socket.addEventListener("error", () =>
      reject(new Error(`cdp: cannot open ${url}`)),
    );

    socket.addEventListener("open", () => {
      const send = (method, params) =>
        new Promise((ok, no) => {
          id += 1;
          pending.set(id, { resolve: ok, reject: no });
          socket.send(JSON.stringify({ id, method, params }));
        });

      resolve({
        send,
        /**
         * Evaluate an expression and get its VALUE back.
         *
         * `awaitPromise` because everything worth driving here is async, and
         * `returnByValue` because the alternative is a remote object handle and a second
         * round trip per field. A report is JSON already -- see `runner.js`, which returns
         * data rather than throwing for exactly this reason.
         */
        eval: async (expression) => {
          const result = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          // A thrown exception in the page is a harness failure, not a test failure, and it
          // must not come back as `undefined` for a caller to misread as an empty report.
          if (result.exceptionDetails) {
            throw new Error(
              `page threw: ${
                result.exceptionDetails.exception?.description ??
                result.exceptionDetails.text
              }`,
            );
          }
          return result.result.value;
        },
        close: () => socket.close(),
      });
    });
  });

/** Every page target, or null when the endpoint is not there at all. */
const pages = async () => {
  try {
    const listed = await fetch(`${ENDPOINT}/json/list`);
    return (await listed.json()).filter((t) => t.type === "page");
  } catch {
    return null;
  }
};

/**
 * Is this target the deck, with the harness up?
 *
 * ASKED OF THE PAGE, NOT OF ITS URL. A title or path match picks the wrong tab the moment
 * two copies of the deck are open, and the right tab before it has finished mounting --
 * and "attached to something that cannot run a fixture" is the failure worth ruling out
 * here rather than three calls later. `window.deckReplay` exists only under `?replay`, so
 * this settles the flag, the mount and the tab in one question.
 */
const probe = async (session) => {
  try {
    return Boolean(await session.eval("Boolean(window.deckReplay?.ready())"));
  } catch {
    // Devtools pages, about:blank, and anything mid-navigation.
    return false;
  }
};

/** An already-open deck tab, or null. */
const findExisting = async (listed) => {
  for (const page of listed) {
    const session = await attach(page.webSocketDebuggerUrl);
    if (await probe(session)) return { session, opened: false };
    session.close();
  }
  return null;
};

/**
 * Open a deck tab and wait for the harness to install.
 *
 * POLLS `deckReplay.ready()` RATHER THAN A LOAD EVENT. `Page.loadEventFired` says the HTML
 * arrived, which on this deck is several seconds before React has committed a fiber tree
 * for `harvest/` to read -- and the tools are registered from `mountChat`, after that. The
 * only honest readiness signal is the one the harness itself publishes.
 */
const openDeck = async () => {
  const url = deckUrl();

  // Checked from Node first, so "the deck is not being served" is reported as itself rather
  // than as a twenty-second timeout waiting for a tab that will never mount.
  try {
    await fetch(url, { method: "HEAD" });
  } catch {
    return { reason: `nothing serving ${DECK} — run \`npm run dev\`` };
  }

  const created = await fetch(`${ENDPOINT}/json/new?${url}`, { method: "PUT" });
  if (!created.ok) {
    return { reason: `Chrome refused a new tab (${created.status})` };
  }
  const target = await created.json();
  const session = await attach(target.webSocketDebuggerUrl);

  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (await probe(session)) return { session, opened: true, id: target.id };
    await sleep(250);
  }

  session.close();
  return { reason: `deck opened but never became ready within ${READY_MS}ms` };
};

/**
 * A session on a ready deck, or a reason there isn't one.
 *
 * `{ reason }` RATHER THAN A THROW, because every reason here is an environment that is
 * simply not set up -- no Chrome, no dev server -- and the caller's right response is to
 * skip and say how, not to fail. A throw is reserved for a browser that IS there and
 * misbehaving.
 */
export const connect = async () => {
  const listed = await pages();
  if (!listed) {
    return {
      reason: `no CDP at ${ENDPOINT} — start Chrome with --remote-debugging-port=9222`,
    };
  }

  return (await findExisting(listed)) ?? (await openDeck());
};

/** Close a tab this module opened, and leave one it merely found. */
export const disconnect = async (deck) => {
  if (!deck?.session) return;
  if (deck.opened && deck.id) {
    await fetch(`${ENDPOINT}/json/close/${deck.id}`, { method: "PUT" }).catch(
      () => {},
    );
  }
  deck.session.close();
};

/**
 * Run one fixture in the page and hand back the report.
 *
 * THE FIXTURE CROSSES AS A JSON STRING inside a `JSON.parse`, rather than being
 * interpolated as an object literal. A fixture holds tool blocks with backticks, braces and
 * emoji; every one of those is a way for string interpolation into an evaluated expression
 * to go quietly wrong, and `JSON.stringify` of the whole thing has exactly one escaping
 * rule to get right.
 */
export const runFixture = (session, fixture, { record = false } = {}) =>
  session.eval(
    `window.deckReplay.${record ? "record" : "run"}(JSON.parse(${JSON.stringify(
      JSON.stringify(fixture),
    )}))`,
  );
