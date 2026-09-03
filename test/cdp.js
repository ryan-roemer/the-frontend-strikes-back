/**
 * Just enough Chrome DevTools Protocol to run a fixture against the deck.
 *
 * NO DEPENDENCIES, ON PURPOSE. Node 22+ has a global `WebSocket`, and everything below is
 * two HTTP calls and one socket. Puppeteer would be ~150MB and a second Chrome to keep this
 * file at eighty lines -- and this repo's whole claim is a short dependency list that
 * `docs/dependencies.md` accounts for line by line.
 *
 * ATTACHES TO A RUNNING BROWSER RATHER THAN LAUNCHING ONE, and OPENS ITS OWN TAB if the
 * deck is not already up. The only thing a person has to arrange is `npm run dev` and
 * `npm run cdp`, which starts a throwaway Chrome on the port `npm test` looks at;
 * requiring them to also open the right URL with the right flag was a step to get wrong
 * before the tests could even run. `CDP_URL` overrides the endpoint for a Chrome that is
 * already open on some other port.
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

/**
 * How long any single CDP call may take before it is treated as a dead target.
 *
 * EVERY CALL IS BOUNDED, and this is not belt-and-braces -- an unbounded one hung the whole
 * suite. A tab can accept a WebSocket and then never answer `Runtime.evaluate`: two
 * unrelated `localhost:4710` tabs running wasm models did exactly that, sitting sixth in
 * `/json/list`, and the probe sweep awaited the first of them forever. `probe()` wraps its
 * call in a try/catch, which cannot help, because a promise that never settles is not an
 * exception -- it is silence, and silence has no handler.
 *
 * Generous, because the alternative failure is worse: too short and a busy but healthy deck
 * gets skipped as dead. Nothing this file asks for legitimately takes seconds -- the long
 * waits are all polling loops built out of many short calls.
 */
const CALL_MS = 5000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Reject if a promise has not settled in time.
 *
 * The timer is cleared on the winning path, so a bounded call that succeeds does not hold
 * the event loop open for the remainder of its budget -- which would add `CALL_MS` to the
 * end of every run.
 */
const bounded = (promise, ms, what) => {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`cdp: ${what} did not answer in ${ms}ms`)),
        ms,
      );
    }),
  ]);
};

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
  bounded(
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
        // BOUNDED AT THE ONE PLACE EVERY CALL GOES THROUGH, so no caller has to remember.
        // The entry is dropped from `pending` however the call ends, including a timeout:
        // a late reply then finds nothing waiting and is discarded, rather than resolving a
        // promise nobody holds. Without that, every timed-out call leaks an entry.
        const send = (method, params) => {
          id += 1;
          const callId = id;
          return bounded(
            new Promise((ok, no) => {
              pending.set(callId, { resolve: ok, reject: no });
              socket.send(JSON.stringify({ id: callId, method, params }));
            }),
            CALL_MS,
            method,
          ).finally(() => pending.delete(callId));
        };

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
    }),
    CALL_MS,
    `attach ${url}`,
  );

/**
 * Every page target that could plausibly be the deck, or null when the endpoint is not
 * there at all.
 *
 * FILTERED BY ORIGIN BEFORE ANYTHING IS ATTACHED. `probe()` below is still the authority on
 * whether a tab is the deck -- its note explains why a URL match cannot be -- but that is an
 * argument about not TRUSTING the URL, not about opening a socket to every tab in somebody's
 * browser. A normal working profile had 22 page targets: mail, drive, two chat apps, three
 * unrelated localhost ports. Probing all of them was ten pointless sockets on a good day and
 * a hang on a bad one, because two of those unrelated tabs answered no CDP call at all.
 *
 * The origin comes from `DECK`, so pointing `DECK_URL` elsewhere moves this with it.
 */
const pages = async () => {
  try {
    const listed = await fetch(`${ENDPOINT}/json/list`);
    const origin = new URL(DECK).origin;
    return (await listed.json()).filter(
      (t) =>
        t.type === "page" &&
        typeof t.url === "string" &&
        t.url.startsWith(origin) &&
        // The PDF export mounts no chat and so registers no tools, and it is a tab people
        // leave open. It would fail `probe()` anyway; skipping it saves a socket and keeps
        // the reload in `findExisting` off a tab somebody is mid-export on.
        !t.url.includes("exportMode") &&
        t.webSocketDebuggerUrl,
    );
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

/**
 * An already-open deck tab, RELOADED, or null.
 *
 * THE RELOAD IS THE WHOLE POINT OF THIS FUNCTION BEING MORE THAN A LOOP, and leaving it
 * out made the suite lie. ES modules are cached per page, so a tab that has been open
 * since before your edit is still running the code you just changed — and every fixture
 * goes on passing against it. Caught by reverting a fix on purpose and watching its own
 * regression test stay green; `docs/chat-handoff.md` §10 warns about exactly this, one
 * layer up, for hand-driven CDP sessions.
 *
 * `ignoreCache: true` because the dev server is `npx serve`, which is happy to answer a
 * conditional request with a 304 for a file that changed a second ago.
 *
 * The cost is a few seconds per run against a warm tab, which is the price of the result
 * meaning anything. A tab we open ourselves (`openDeck`) is fresh by construction and
 * needs none of this.
 */
const findExisting = async (listed) => {
  for (const page of listed) {
    // A TAB THAT CANNOT BE REACHED IS SKIPPED, NOT FATAL. `attach` and every call under it
    // are bounded now, so a wedged tab rejects rather than hanging -- but rejecting out of
    // here would fail the whole suite over somebody's stuck background tab, which is
    // exactly the wrong response. Keep looking.
    let session = null;
    try {
      session = await attach(page.webSocketDebuggerUrl);
      if (!(await probe(session))) {
        session.close();
        continue;
      }
    } catch {
      session?.close();
      continue;
    }

    await session.send("Page.enable");
    await session.send("Page.reload", { ignoreCache: true });

    // Re-probe on the SAME schedule `openDeck` uses. `Page.reload` resolves when the
    // navigation is accepted, not when the deck has mounted, so without this the first
    // fixture runs against a page with no `deckReplay` at all.
    const deadline = Date.now() + READY_MS;
    while (Date.now() < deadline) {
      if (await probe(session)) return { session, opened: false };
      await sleep(250);
    }

    session.close();
    return {
      reason: `deck tab reloaded but never became ready within ${READY_MS}ms`,
    };
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
      reason: `no CDP at ${ENDPOINT} — run \`npm run cdp\`, or point CDP_URL at a Chrome you already have`,
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
