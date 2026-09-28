// Records every file the deck loads from another host and saves a copy under
// `offline/`, for `sw.js` to serve when there is no network.
//
//   npm run offline:fetch            # reuse files already saved
//   npm run offline:fetch -- --force # fetch everything again
//
// Needs `npm run dev` and a CDP Chrome (`npm run cdp`), the same as `npm test`.
//
// Four sources of URLs, because no one of them is complete:
//
//   1. THE LOAD. Over CDP, with the service worker bypassed and the cache off, it
//      loads the deck, opens the assistant and the tools panel, walks every slide
//      (backgrounds only load when their slide is shown), and loads the LiteRT
//      runtime without a model. Every request to a non-localhost host is kept,
//      with the headers Chrome sent.
//   2. THE LITERT WASM DIRECTORY. The runtime picks one of four builds by feature
//      detection (relaxed SIMD x JSPI). The load records the one this Chrome picks;
//      the package listing adds the other three, so a different Chrome still works.
//   3. THE JS CLOSURE. Starting from the import map's bare entries, every module is
//      scanned for `/npm/…` imports, which are resolved through the map and fetched
//      if missing. This finds modules that nothing rendered, such as
//      `deck/code-editor.js`'s react-live chunk.
//   4. THE CSS CLOSURE. Every saved CSS file is scanned for `url(…)`. Google Fonts
//      splits each face into unicode-range subsets and Chrome only fetches the ones
//      the page used, so a character no slide showed would otherwise miss.
//
// It exits non-zero, with the list, if any URL could not be saved.
//
// Layout (gitignored):
//
//   offline/manifest.json   { url: { file, type, bytes } }
//   offline/files/<sha256>  one file per URL, named by the hash of the URL

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { connect, disconnect, untilReady } from "../test/cdp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "offline");
const FILES = resolve(OUT, "files");
const MANIFEST = resolve(OUT, "manifest.json");

const FORCE = process.argv.includes("--force");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PARALLEL = 8;

// How long the network must be quiet before a step counts as finished, and the most
// any one step may wait for that.
const QUIET_MS = 750;
const STEP_MS = 30000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const isExternal = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && !LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
};

// Request headers worth replaying. Google Fonts picks woff2 over older formats by
// User-Agent, so that one matters. Encoding is left to Node's fetch, which decodes it,
// and conditional or range headers would get a 304 or a partial body.
const DROP_HEADERS =
  /^(:|accept-encoding$|range$|if-|cookie$|host$|connection$)/i;
const replayable = (headers = {}) =>
  Object.fromEntries(
    Object.entries(headers).filter(([k]) => !DROP_HEADERS.test(k)),
  );

// ---------------------------------------------------------------------------
// 1. Record the load over CDP.

const record = async () => {
  const deck = await connect();
  if (!deck.session) throw new Error(deck.reason);
  const { session } = deck;

  const seen = new Map(); // url -> request headers
  const inflight = new Set();
  let lastActivity = Date.now();
  const touch = () => (lastActivity = Date.now());

  session.on("Network.requestWillBeSent", ({ requestId, request }) => {
    touch();
    inflight.add(requestId);
    if (isExternal(request.url) && !seen.has(request.url)) {
      seen.set(request.url, replayable(request.headers));
    }
  });
  for (const done of ["Network.loadingFinished", "Network.loadingFailed"]) {
    session.on(done, ({ requestId }) => {
      touch();
      inflight.delete(requestId);
    });
  }

  // Quiet means nothing in flight and nothing new for QUIET_MS. A long-poll or a stuck
  // request would keep `inflight` non-empty forever, hence the cap.
  const settle = async () => {
    const deadline = Date.now() + STEP_MS;
    while (Date.now() < deadline) {
      if (inflight.size === 0 && Date.now() - lastActivity > QUIET_MS) return;
      await sleep(100);
    }
  };

  // Every request has to reach the network, where CDP can see it. With the service
  // worker in the way, a second run would record only what the first run missed.
  await session.send("Network.enable");
  await session.send("Network.setBypassServiceWorker", { bypass: true });
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });

  const home = new URL(await session.eval("location.href"));
  home.searchParams.set("chat", "1");
  home.searchParams.delete("slideIndex");
  home.searchParams.delete("stepIndex");
  await session.send("Page.navigate", { url: home.toString() });
  if (!(await untilReady(session))) throw new Error("deck never became ready");
  await settle();

  // The deck's own modules, imported from inside the page, so these are the same
  // instances the deck is running rather than fresh copies.
  const page = (expression) =>
    session.eval(`(async () => {
      const deck = (path) => import(new URL(path, document.baseURI).href);
      ${expression}
    })()`);

  await page(`(await deck("chat/tools/state.js")).setOpen(true);`);
  await settle();

  const count = await page(`return (await deck("chat/nav.js")).nav.count();`);
  for (let slide = 1; slide <= count; slide += 1) {
    process.stdout.write(`\rslide ${slide}/${count}`);
    await page(`await (await deck("chat/nav.js")).nav.toSlide(${slide});`);
    await settle();
  }
  process.stdout.write("\n");

  // The runtime without a model: the glue script and one `.wasm`. A failure here is
  // reported, not fatal, because step 2 below saves the whole directory anyway.
  const { wasmPath, wasmError } = await page(`
    const litert = await import("@litert-lm/core");
    const wasmPath = litert.LiteRtLm.DEFAULT_WASM_PATH;
    try {
      await litert.getOrLoadGlobalLiteRtLm();
      return { wasmPath };
    } catch (err) {
      return { wasmPath, wasmError: String(err?.message || err) };
    }
  `);
  if (wasmError)
    console.warn(`! LiteRT runtime did not load in the page: ${wasmError}`);
  await settle();

  // Put the tab back the way a presenter would want it: first slide, service worker
  // in charge again, runtime unloaded.
  await session.send("Network.setBypassServiceWorker", { bypass: false });
  await session.send("Network.setCacheDisabled", { cacheDisabled: false });
  await session.send("Network.disable");
  home.searchParams.delete("chat");
  await session.send("Page.navigate", { url: home.toString() });
  await disconnect(deck);

  const userAgent = [...seen.values()].find((h) => h["User-Agent"])?.[
    "User-Agent"
  ];
  return { seen, wasmPath, userAgent };
};

// ---------------------------------------------------------------------------
// 2. Every file in the LiteRT wasm directory.

const wasmDirectory = async (wasmPath) => {
  const m = wasmPath.match(
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)(\/.*?)\/?$/,
  );
  if (!m) {
    console.warn(
      `! LiteRT wasm path is not on jsDelivr, only the loaded build is saved: ${wasmPath}`,
    );
    return [];
  }
  const [, name, version, dir] = m;
  const res = await fetch(
    `https://data.jsdelivr.com/v1/packages/npm/${name}@${version}?structure=flat`,
  );
  if (!res.ok)
    throw new Error(
      `jsDelivr listing for ${name}@${version}: HTTP ${res.status}`,
    );
  const { files } = await res.json();
  return files
    .map((f) => f.name)
    .filter((path) => path.startsWith(`${dir}/`))
    .map((path) => `https://cdn.jsdelivr.net/npm/${name}@${version}${path}`);
};

// ---------------------------------------------------------------------------
// 3. The import map, resolved the way the browser does it.

const readImportMap = async () => {
  const html = await readFile(resolve(ROOT, "index.html"), "utf8");
  const json = html.match(
    /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/,
  )?.[1];
  if (!json) throw new Error("no import map in index.html");
  return JSON.parse(json);
};

// Longest key first, prefix keys (ending in `/`) and exact keys both. The same rules as
// `docs/dependencies.md` §2 and its audit script, plus scopes.
const matcher = (table) => {
  const keys = Object.entries(table).sort((a, b) => b[0].length - a[0].length);
  return (specifier) => {
    for (const [key, value] of keys) {
      if (key.endsWith("/") ? specifier.startsWith(key) : specifier === key) {
        return key.endsWith("/") ? value + specifier.slice(key.length) : value;
      }
    }
    return null;
  };
};

const resolver = (map) => {
  const top = matcher(map.imports ?? {});
  const scopes = Object.entries(map.scopes ?? {})
    .sort((a, b) => b[0].length - a[0].length)
    .map(([prefix, table]) => [prefix, matcher(table)]);
  return (specifier, importer) => {
    for (const [prefix, match] of scopes) {
      if (importer?.startsWith(prefix)) {
        const hit = match(specifier);
        if (hit) return hit;
      }
    }
    return top(specifier) ?? specifier;
  };
};

// jsDelivr bundles import root-relative `/npm/…` paths. The local shims spell the CDN
// out in full. Both forms, static and dynamic.
const IMPORTS =
  /(?:from|import)\s*\(?\s*["'](?:https:\/\/cdn\.jsdelivr\.net)?(\/npm\/[^"']+)["']/g;
const cdnImports = (text) =>
  [...text.matchAll(IMPORTS)].map((m) => `https://cdn.jsdelivr.net${m[1]}`);

// `url(…)` and `@import "…"`, resolved against the stylesheet's own URL. Fragments
// are dropped: the browser never sends them.
const CSS_URLS = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
const cssUrls = (text, base) =>
  [...text.matchAll(CSS_URLS)]
    .map((m) => (m[2] ?? m[4]).trim())
    .filter((u) => !u.startsWith("data:"))
    .map((u) => {
      const url = new URL(u, base);
      url.hash = "";
      return url.href;
    });

// ---------------------------------------------------------------------------
// Saving.

const fileFor = (url) =>
  `files/${createHash("sha256").update(url).digest("hex")}`;

const readManifest = async () => {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    return {};
  }
};

const exists = async (path, bytes) => {
  try {
    return (await stat(path)).size === bytes;
  } catch {
    return false;
  }
};

const save = async (url, headers, previous) => {
  const file = fileFor(url);
  const path = resolve(OUT, file);
  const old = previous[url];
  if (!FORCE && old && (await exists(path, old.bytes)))
    return { ...old, reused: true };

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // A redirected module or stylesheet would resolve its imports against the final URL
  // online, but against the requested one when `sw.js` answers. Nothing redirects
  // today; this is here so a new one is noticed.
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  if (res.redirected && /javascript|css/.test(type)) {
    console.warn(
      `! ${url} redirects to ${res.url}; relative imports may break offline`,
    );
  }

  const partial = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  const { size } = await stat(partial);

  // Node's fetch decodes gzip and brotli, so `content-length` only means the body size
  // when there was no encoding.
  const length = res.headers.get("content-length");
  if (
    length &&
    !res.headers.get("content-encoding") &&
    Number(length) !== size
  ) {
    await rm(partial, { force: true });
    throw new Error(`truncated: ${size} of ${length} bytes`);
  }
  await rename(partial, path);
  return { file, type, bytes: size };
};

// ---------------------------------------------------------------------------

const main = async () => {
  await mkdir(FILES, { recursive: true });
  const previous = await readManifest();
  const map = await readImportMap();
  const resolveSpecifier = resolver(map);

  console.log("recording the deck over CDP…");
  const { seen, wasmPath, userAgent } = await record();
  console.log(`  ${seen.size} external URLs, LiteRT wasm from ${wasmPath}`);

  const defaults = {
    ...(userAgent && { "User-Agent": userAgent }),
    Accept: "*/*",
  };
  // Everything to save, with the headers to fetch it with.
  const want = new Map(seen);
  for (const url of await wasmDirectory(wasmPath)) {
    if (!want.has(url)) want.set(url, defaults);
  }

  // The modules whose imports are followed: only what the import map can reach.
  // jsDelivr's `modulepreload` Link headers make Chrome download bundles it never runs
  // (docs/dependencies.md §9). Following those pulled in all of highlight.js and
  // refractor@3 (660 files) through the react-syntax-highlighter entry that
  // `deck/rsh-prism.js` replaces. Preloaded files are still saved, so the preload
  // finds a copy offline. Their imports are just not followed.
  const follow = new Set();
  const reach = async (target) => {
    if (follow.has(target)) return;
    follow.add(target);
    if (target.startsWith("./")) {
      // A local shim. `sw.js` never sees it, but its CDN imports count.
      const text = await readFile(resolve(ROOT, target), "utf8");
      await Promise.all(
        cdnImports(text).map((s) => reach(resolveSpecifier(s, target))),
      );
    } else if (!want.has(target)) {
      want.set(target, defaults);
    }
  };

  // Roots: every bare entry in the map, as the audit script does. A mapped value is
  // not mapped a second time, so these are used as they are.
  await Promise.all(
    Object.entries(map.imports)
      .filter(([key]) => !key.startsWith("https://"))
      .map(([, value]) => reach(value)),
  );

  // Save, scan what was saved, repeat until nothing new turns up. Every saved
  // stylesheet is scanned, since only applied ones were recorded or reached.
  const manifest = {};
  const failed = new Map();
  const scanned = new Set();
  let fetched = 0;
  for (;;) {
    const batch = [...want.keys()].filter(
      (url) => !manifest[url] && !failed.has(url),
    );
    const toScan = Object.keys(manifest).filter(
      (url) =>
        !scanned.has(url) &&
        (follow.has(url) || manifest[url].type.includes("css")),
    );
    if (batch.length === 0 && toScan.length === 0) break;

    for (let i = 0; i < batch.length; i += PARALLEL) {
      await Promise.all(
        batch.slice(i, i + PARALLEL).map(async (url) => {
          try {
            const { reused, ...entry } = await save(
              url,
              want.get(url),
              previous,
            );
            manifest[url] = entry;
            fetched += reused ? 0 : 1;
            process.stdout.write(
              `\r${Object.keys(manifest).length} saved, ${fetched} fetched`,
            );
          } catch (err) {
            failed.set(url, err.message);
          }
        }),
      );
    }

    for (const url of toScan) {
      scanned.add(url);
      const text = await readFile(resolve(OUT, manifest[url].file), "utf8");
      if (manifest[url].type.includes("css")) {
        for (const u of cssUrls(text, url))
          if (!want.has(u)) want.set(u, defaults);
      } else {
        await Promise.all(
          cdnImports(text).map((s) => reach(resolveSpecifier(s, url))),
        );
      }
    }
  }
  process.stdout.write("\n");

  // The manifest lists exactly what this run found. Files from earlier runs that
  // nothing points at any more are removed.
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
  const keep = new Set(
    Object.values(manifest).map((e) => e.file.slice("files/".length)),
  );
  for (const name of await readdir(FILES)) {
    if (!keep.has(name)) await rm(resolve(FILES, name), { force: true });
  }

  const bytes = Object.values(manifest).reduce((n, e) => n + e.bytes, 0);
  const hosts = new Map();
  for (const url of Object.keys(manifest)) {
    const host = new URL(url).hostname;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  console.log(
    `saved ${Object.keys(manifest).length} URLs, ${(bytes / 2 ** 20).toFixed(1)} MiB, to offline/`,
  );
  for (const [host, n] of [...hosts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${host}`);
  }

  if (failed.size) {
    console.error(`\n${failed.size} URL(s) could not be saved:`);
    for (const [url, why] of failed) console.error(`  ${why}  ${url}`);
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(`offline:fetch: ${err.message}`);
  process.exitCode = 1;
});
