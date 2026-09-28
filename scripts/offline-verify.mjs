// Loads the deck with `?offline` and every non-localhost request blocked, walks every
// slide, and reports anything that tried to leave the machine. The seed for phase 4's
// `npm run offline:check` (docs/handoffs/offline-handoff.md); not wired to npm yet.
//
//   node scripts/offline-verify.mjs              # needs `npm run dev`, a CDP Chrome
//   node scripts/offline-verify.mjs --shots      # also saves offline/verify/slide-N.jpg
//   node scripts/offline-verify.mjs --no-flag    # the same walk WITHOUT `?offline`
//   node scripts/offline-verify.mjs --gemma      # then load Gemma and ask it a question
//
// Point CDP_URL at the Chrome, as `npm test` does (`npm run cdp` listens on :1980).
//
// `--gemma` needs `npm run offline:model` and a GPU. It loads the model with the blocks
// still on, so on a profile without the model cached, the 2 GB has to come from
// `offline/models/` through the worker. It reports whether the model was cached before,
// because a cache hit doesn't test the worker at all: use a fresh profile for that.
//
// `--no-flag` is the inverse check. The worker must leave a flagless page alone, so
// the deck is expected to fail, with its CDN requests reaching the network and getting
// blocked there. It exits 0 only if that is what happened.
//
// BLOCKED WITH THE `Fetch` DOMAIN, NOT `Network.setBlockedURLs`. On the page target,
// `setBlockedURLs` blocks requests before the service worker sees them, so the deck
// fails even with every file on disk. `Fetch` interception sits at the network layer,
// after the worker, so on the page and the worker targets together it catches exactly
// the requests that would really leave the machine.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENDPOINT,
  attach,
  connect,
  disconnect,
  untilReady,
} from "../test/cdp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = resolve(ROOT, "offline", "verify");

const FLAG = !process.argv.includes("--no-flag");
const TAKE_SHOTS = process.argv.includes("--shots");
const GEMMA = process.argv.includes("--gemma");

// How long to let lazy requests (backgrounds, fonts) land after each slide change.
const SLIDE_MS = 800;
// How long the model may take to copy into the cache, load onto the GPU and answer.
const GEMMA_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);
const isExternal = (url) => /^https?:/.test(url) && !isLocal(url);

const withFlag = (href) => {
  const url = new URL(href);
  if (FLAG) url.searchParams.set("offline", "1");
  else url.searchParams.delete("offline");
  return url;
};

const leaked = []; // reached the network and were blocked
const failed = []; // any request that failed, for whatever reason
const external = new Map(); // url -> { fromServiceWorker, status }
const errors = [];

/** Fail every non-localhost request that reaches the network from this target. */
const block = async (session, label) => {
  session.on("Fetch.requestPaused", ({ requestId, request }) => {
    if (isLocal(request.url)) {
      session.send("Fetch.continueRequest", { requestId }).catch(() => {});
      return;
    }
    leaked.push(`${label}  ${request.url}`);
    session
      .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      .catch(() => {});
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
};

const watch = async (session, label) => {
  const urls = new Map();
  session.on("Network.requestWillBeSent", ({ requestId, request }) =>
    urls.set(requestId, request.url),
  );
  session.on("Network.loadingFailed", ({ requestId, errorText }) =>
    failed.push(`${label}  ${errorText}  ${urls.get(requestId)}`),
  );
  session.on("Network.responseReceived", ({ response }) => {
    if (label === "page" && isExternal(response.url)) {
      external.set(response.url, {
        fromServiceWorker: response.fromServiceWorker,
        status: response.status,
      });
    }
  });
  await session.send("Network.enable");
};

/**
 * Load Gemma through the deck's own provider and ask it one question.
 *
 * Started inside the page and then polled, because every CDP call is capped at a few
 * seconds (`test/cdp.js`) and this takes a minute or more.
 */
const askGemma = async (page) => {
  const started = await page(`
    const { provider } = await deck("chat/agent/providers/litert.js");
    const run = (window.__offlineVerifyGemma = { before: await provider.status() });
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    (async () => {
      try {
        const chat = await provider.acquire({
          system: "Answer in one short sentence.",
          onPhase: ({ phase, text }) => {
            run[phase] ??= ms();
            run.progress = text;
          },
        });
        run.loaded = ms();
        let answer = "";
        for await (const delta of chat.stream("What is a service worker?")) {
          answer += delta;
        }
        run.answer = answer.trim();
        run.answered = ms();
        chat.destroy();
      } catch (err) {
        run.error = String(err?.message || err);
      }
    })();
    return run.before;`);
  if (typeof started !== "string") return { error: JSON.stringify(started) };

  const deadline = Date.now() + GEMMA_MS;
  let run = {};
  while (Date.now() < deadline) {
    run = await page(`return { ...window.__offlineVerifyGemma };`);
    process.stdout.write(`\rgemma: ${run.progress ?? run.before}`.padEnd(60));
    if (run.error || run.answer !== undefined) break;
    await sleep(1000);
  }
  process.stdout.write("\n");
  if (!run.error && run.answer === undefined) run.error = "timed out";
  delete run.progress;
  return run;
};

const main = async () => {
  const deck = await connect();
  if (!deck.session) throw new Error(deck.reason);
  const { session } = deck;

  // Load once with the network open, so a profile with no worker yet gets one: the
  // first `?offline` load fetches its modules before the worker activates.
  const home = withFlag(await session.eval("location.href"));
  home.searchParams.delete("slideIndex");
  home.searchParams.delete("stepIndex");
  await session.send("Page.navigate", { url: home.toString() });
  if (!(await untilReady(session))) throw new Error("deck never became ready");

  const origin = home.origin;
  let worker = null;
  if (FLAG) {
    const controlled = await session.eval(
      `navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)`,
    );
    const targets = await (await fetch(`${ENDPOINT}/json/list`)).json();
    const target = targets.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`${origin}/`),
    );
    if (!controlled || !target) {
      throw new Error(
        `service worker not in control (controlled: ${controlled}, target: ${!!target})`,
      );
    }
    worker = await attach(target.webSocketDebuggerUrl);
    await watch(worker, "sw");
    await block(worker, "sw");
  }

  await watch(session, "page");
  await block(session, "page");
  await session.send("Runtime.enable");
  session.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type !== "error") return;
    const text = args.map((a) => a.value ?? a.description).join(" ");
    // LiteRT's wasm writes its INFO and WARNING log lines to stderr, which Emscripten
    // turns into `console.error`. Its ERROR lines still count.
    if (/^(INFO|WARNING): \[/.test(text)) return;
    errors.push(text);
  });
  session.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) =>
    errors.push(d.exception?.description ?? d.text),
  );

  // Cache off, so nothing hides behind the HTTP cache.
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  home.searchParams.set("chat", "1");
  await session.send("Page.navigate", { url: home.toString() });
  const ready = await untilReady(session);

  // The deck's own modules, imported inside the page. Failures come back as data.
  const page = (expression) =>
    session
      .eval(
        `(async () => {
          const deck = (path) => import(new URL(path, document.baseURI).href);
          ${expression}
        })()`,
      )
      .catch((err) => ({ threw: err.message }));

  const report = { ready, slides: 0 };
  if (ready) {
    // The chat panel is open (its imports ran) but would cover the screenshots.
    await page(`(await deck("chat/state.js")).setEnabled(false);`);
    report.slides = await page(
      `return (await deck("chat/nav.js")).nav.count();`,
    );
    if (TAKE_SHOTS) await mkdir(SHOTS, { recursive: true });
    for (let n = 1; n <= report.slides; n += 1) {
      process.stdout.write(`\rslide ${n}/${report.slides}`);
      await page(`await (await deck("chat/nav.js")).nav.toSlide(${n});`);
      await sleep(SLIDE_MS);
      if (TAKE_SHOTS) {
        const { data } = await session.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 60,
        });
        await writeFile(
          resolve(SHOTS, `slide-${n}.jpg`),
          Buffer.from(data, "base64"),
        );
      }
    }
    process.stdout.write("\n");
    await page(`(await deck("chat/tools/state.js")).setOpen(true);`);

    report.fonts = await page(`
      await document.fonts.ready;
      return [...new Set([...document.fonts]
        .filter((f) => f.status === "loaded").map((f) => f.family))];`);
    report.litert = await page(`
      const started = performance.now();
      try {
        await (await import("@litert-lm/core")).getOrLoadGlobalLiteRtLm();
        return { ok: true, ms: Math.round(performance.now() - started) };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }`);
    if (GEMMA) report.gemma = await askGemma(page);
    await sleep(1000);
  }

  // Put the tab back: nothing blocked, cache on, real viewport, first slide.
  for (const s of [session, worker].filter(Boolean)) {
    await s.send("Fetch.disable").catch(() => {});
  }
  await session.send("Network.setCacheDisabled", { cacheDisabled: false });
  await session.send("Emulation.clearDeviceMetricsOverride");
  home.searchParams.delete("chat");
  await session.send("Page.navigate", { url: home.toString() });
  worker?.close();
  await disconnect(deck);

  const notFromWorker = [...external].filter(([, r]) => !r.fromServiceWorker);
  console.log(`${FLAG ? "with" : "WITHOUT"} ?offline`);
  console.log(`  ready: ${report.ready}, slides walked: ${report.slides}`);
  if (report.fonts) console.log(`  fonts loaded: ${report.fonts.join(", ")}`);
  if (report.litert) console.log(`  LiteRT runtime:`, report.litert);
  const model = [...external].find(([url]) => url.endsWith(".litertlm"));
  if (GEMMA) {
    console.log(`  Gemma:`, report.gemma);
    console.log(
      `  model response: ${model ? `${model[1].status}, from the service worker: ${model[1].fromServiceWorker}` : "none (cache hit)"}`,
    );
    if (report.gemma?.before !== "downloadable") {
      console.log(
        "  NOTE: the model was already cached, so this didn't test serving it from offline/models/. Use a fresh profile for that.",
      );
    }
  }
  console.log(
    `  external responses: ${external.size}, not from the service worker: ${notFromWorker.length}`,
  );
  const list = (title, items) => {
    console.log(`  ${title}: ${items.length}`);
    for (const item of items.slice(0, 40)) console.log(`    ${item}`);
  };
  list("reached the network (blocked)", leaked);
  list("failed requests", failed);
  list(
    "console errors",
    errors.map((e) => String(e).slice(0, 200)),
  );
  if (TAKE_SHOTS) console.log(`  screenshots: ${SHOTS}`);

  const clean =
    report.ready &&
    leaked.length === 0 &&
    failed.length === 0 &&
    errors.length === 0 &&
    (!GEMMA || Boolean(report.gemma?.answer));
  const pass = FLAG ? clean : !report.ready && leaked.length > 0;
  console.log(pass ? "PASS" : "FAIL");
  if (!pass) process.exitCode = 1;
};

main().catch((err) => {
  console.error(`offline-verify: ${err.message}`);
  process.exitCode = 1;
});
