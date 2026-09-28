# Offline mode — plan and handoffs

Goal: present the whole talk with wifi off. The deck, its assistant, its images and the backup
demo videos all come from the laptop. **Local dev only**: nothing here has to work on GitHub
Pages, and nothing here may change how the published deck behaves.

Status: **phase 1 built** (service worker and `offline:fetch`). Phases 2–5 are planned. Each phase below is sized for one session and ends with a
handoff prompt you can paste into a new session.

**Two docs, two readers.** This file is for whoever builds the feature.
[`../offline.md`](../offline.md) is for the presenter: terse, commands and steps only. Every
phase that changes a command or a step updates `offline.md` in the same change, and removes
its "planned" banner once phase 4 lands.

---

## 1. What leaves the machine today

| What                                               | From                                   | Loaded when                                  |
| -------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| ~870 ES modules (React, Spectacle, …)              | `cdn.jsdelivr.net`, via the import map | every load                                   |
| Phosphor icon CSS + its font files                 | `cdn.jsdelivr.net`                     | every load                                   |
| Inter / Fira Code                                  | `fonts.googleapis.com` → `gstatic.com` | every load                                   |
| Slide backgrounds                                  | `images.unsplash.com`                  | when a slide is shown                        |
| Nearform logo                                      | `encrypted-tbn0.gstatic.com`           | every load                                   |
| `@litert-lm/core` wasm (one of 4 builds, 21–34 MB) | `cdn.jsdelivr.net/…/wasm`              | first Gemma load                             |
| Gemma 4 E2B, 2,008,432,640 bytes                   | `huggingface.co`                       | download click, then cached in the Cache API |
| Gemini Nano (Prompt API)                           | Chrome itself                          | browser-managed, per profile                 |
| `serve`, `@mcp-b/webmcp-local-relay`               | npm, via `npx`                         | `npm run dev`, `npm run demo:relay`          |

Two risks already exist today, before any of the new work:

- **`npm run cdp:stop` runs `rm -rf /tmp/tfsb-chrome-cdp`.** That deletes the cached Gemma
  model, Gemini Nano, and (once it exists) the service worker. Don't present from that profile.
- **`npx serve` without network** only works if npx happens to have it cached.

---

## 2. The approach: a service worker, not an import map swap

A localhost-only service worker (`/sw.js`) intercepts requests to the external hosts above. If
it has a local copy of the URL, it answers with that copy. Otherwise it passes the request
through to the network. `index.html`'s import map, CSS links and `deck/media.js` **stay exactly
as they are.**

### Why not swap the import map

The obvious approach is a second import map that points at `./vendor/…`. It breaks in a way
that is hard to spot:

- jsDelivr bakes **root-relative** specifiers into every bundle (`/npm/react@19.2.0/+esm`).
  Once a module is served from localhost, those resolve against `localhost:3000`. Then none of
  the `https://cdn.jsdelivr.net/npm/react@…/` prefix remaps match, and the React singleton rule
  ([dependencies.md §4](../dependencies.md#4-the-react-singleton-rule)) breaks.
- The Spectacle **scope** is keyed on the importer's jsDelivr URL, so it would break the same
  way.
- Fixing that means rewriting every key and value in the map, serving `/npm/…` from the repo
  root with a custom MIME type for extensionless `+esm` files, **and** swapping the CSS links
  and image URLs separately. That is the mini-library you were worried about, and it would be
  fragile.

With a service worker, every module keeps its jsDelivr URL, so the import map's rules resolve
exactly as they do online.

### The one rule the service worker must follow

**Answer with a synthetic `new Response(body, { headers })`, never the `Response` from
`fetch('/offline/…')`.** A module's base URL is its response URL. A synthetic response has
none, so the browser falls back to the request URL (jsDelivr), which keeps both `/npm/…`
imports and the Phosphor CSS's relative `url(…)` font paths pointing where they should. If
you pass the local fetch's response straight through, every module's base URL silently becomes
localhost.

### No Chrome extension

An extension would intercept the same requests the service worker does, but it would need a
separate install and would be tied to one browser profile. It adds nothing here.

### Layout (all gitignored)

```
offline/
  manifest.json        { url → { file, type, bytes } }, written by the fetch script
  files/<sha256(url)>  one file per URL, so `+esm`, query strings and hosts need no escaping
  models/gemma-4-E2B-it-web.litertlm
```

`sw.js` sits at the repo root (it has to, so its scope covers `/`). It is registered only when
`location.hostname` is `localhost` or `127.0.0.1` **and** the URL has `?offline`. On GitHub
Pages the file is published but never registered. Offline mode is opt-in per page load, so
you never have to delete a file to turn it off (see phase 1 below).

When a dependency is bumped, a URL that isn't in the manifest just goes to the network. A stale
`offline/` directory therefore degrades to "online as usual", not to a broken deck.

---

## 3. Phases

```
 Phase 1  SW + CDP recorder (JS/CSS/fonts/images/wasm) ──► Phase 2  model ──► Phase 4  check + skill
 Phase 3  demo videos (independent: run it any time, in parallel)
 Phase 5  external demo sites (estimate only, later)
```

### Phase 1 — service worker and the "load" recorder ✅ done

**Delivered:** `sw.js`, the registration snippet in `index.html`'s `<head>`,
`scripts/offline-fetch.mjs`, `npm run offline:fetch` (`-- --force` re-fetches everything), and
`offline/` in `.gitignore`. `test/cdp.js` gained `session.on(method, fn)` for CDP events and an
exported `untilReady(session)`; nothing else in it changed and `npm test` still passes.

**Result today:** 301 URLs, 119 MiB: 281 jsDelivr, 14 gstatic fonts, 3 Unsplash, 2 Google Fonts
CSS, 1 logo. A first run takes about 75 s; a re-run reuses saved files and takes under 10 s.

**`sw.js`, as built:**

- **Opt-in with `?offline`** (also `=true` or `=1`, the same values as `chat/url.js`
  `flag()`). The `<head>` snippet registers the worker only with the flag, and
  `?offline=false` or `=0` unregisters it.
- **Per page, not global.** The worker notes whether each page's navigation URL had the flag,
  keyed by `resultingClientId`. It doesn't intercept anything for a page without it, so a
  flagless load behaves as if the worker weren't there, even while it's installed. If the
  browser restarts the worker, the map is lost, and it rebuilds it from `clients.get(id).url`.
  That works because Spectacle keeps extra query params when it changes slides.
- **Spectacle mode switches** (presenter, overview, print) rebuild the query string and drop
  the flag. `deck/components.js` already works around this for overview thumbnail clicks, but
  not for the others. A sticky mode, stored by the worker until `?offline=false`, would avoid
  this; it wasn't chosen, so that you always opt in explicitly.
- **The first `?offline` load on a profile with no worker** fetches its modules before the
  worker activates. Load it once while online, or reload once. `sw.js` is on localhost, so
  registering works even with wifi off.
- Loads `offline/manifest.json` at startup and again on every navigation, so a new
  `offline:fetch` takes effect on the next reload.
- For a page with the flag, once the manifest is loaded, a URL that isn't in it is **not
  intercepted at all**, so it goes to the network exactly as it would without the worker. The
  worker answers with `fetch(request)` only while the manifest or the page's flag is still
  unknown.
- Answers with `new Response(localFile.body, { headers })` carrying the manifest's
  `content-type` and `content-length`. The body is piped, not buffered.
- `skipWaiting()` plus `clients.claim()`, so the first load after registering is controlled as
  soon as the worker activates.
- The registration is a **classic** `<script>`, not a module, so it can't run ahead of the
  import map.

**The recorder** attaches with `connect()` from `test/cdp.js`, then:

1. `Network.enable`, `setBypassServiceWorker(true)` and `setCacheDisabled(true)`. Without the
   cache flag, memory-cache hits never reach the network, so they're never recorded.
2. Reloads with `?chat=1`, opens the tools panel, and walks every slide through the deck's own
   `chat/nav.js` (imported inside `Runtime.evaluate`, so it's the same instance the deck runs).
   It waits for the network to go quiet after each step.
3. Loads the LiteRT runtime **without a model** (`getOrLoadGlobalLiteRtLm()`), so the glue and
   `.wasm` this Chrome picks are recorded for real.
4. Re-fetches every URL from Node with the request headers Chrome sent (minus encoding,
   conditional, range and cookie headers). Google Fonts needs the UA to serve woff2.
5. **Closures, repeated until nothing new turns up:**
   - **JS:** starts from the import map's bare entries (mapped values are not mapped a second
     time) and follows `/npm/…` imports through the map, scopes included. Local shims are read
     from disk. This is what saves react-live and sucrase, which no slide loads.
   - **CSS:** every saved stylesheet is scanned for `url(…)`. Google Fonts splits each face into
     unicode-range subsets, and Chrome only fetches the ones a slide used. This adds the
     subsets for characters no slide happened to show.
6. Writes `manifest.json` with exactly the URLs this run found, and deletes orphaned files. It
   **exits 1 with a list** of any URL it couldn't save.

**Only follow imports from modules the import map reaches.** The first version followed every
recorded JS file and saved 944 URLs. The extra ~640 were all of highlight.js and refractor@3,
pulled in through `react-syntax-highlighter@15.6.6/+esm`. Chrome downloads that file only
because of jsDelivr's `modulepreload` Link header
([dependencies.md §9](../dependencies.md#9-gotchas)), and never runs it. Preloaded files are
still saved, so the preload is answered offline, but their imports aren't followed.

**Settled: what `LiteRtLm.DEFAULT_WASM_PATH` loads.** It's a directory,
`…/@litert-lm/core@0.17.1/wasm`, containing four builds. `load.js` picks one by feature
detection:

| relaxed SIMD | JSPI | files                                                               |
| ------------ | ---- | ------------------------------------------------------------------- |
| yes          | yes  | `litertlm_wasm_internal.{js,wasm}` (21.7 MB), what Chrome 153 loads |
| yes          | no   | `litertlm_wasm_asyncify_internal.{js,wasm}` (34.1 MB)               |
| no           | yes  | `litertlm_wasm_compat_internal.{js,wasm}` (21.5 MB)                 |
| no           | no   | `litertlm_wasm_compat_asyncify_internal.{js,wasm}` (34.0 MB)        |

The `.js` glue is injected as `<script crossorigin="anonymous">` by `@litertjs/wasm-utils`, and
Emscripten fetches the `.wasm` next to it (`instantiateStreaming`, so the `application/wasm`
type matters). The build is chosen by feature, not by GPU backend. The recorder saves **all
four**, using jsDelivr's package listing (`data.jsdelivr.com/v1/packages/npm/<pkg>@<ver>`), so
a different Chrome still works offline. That costs about 110 MB of the 119.

**Verified.** In a fresh headless Chrome 153 profile, with the worker in control and every
non-localhost request failed over CDP on both the page and the service worker targets:

- The deck mounts, and all 29 slides walk with no blocked or failed request and no console
  error.
- All 196 external responses came from the service worker. Nothing reached the network.
- Inter, Fira Code, Phosphor and Phosphor-Fill load, and the chapter photos show (checked on
  screenshots).
- The LiteRT runtime loads from disk in about 50 ms.
- **Without `?offline`**, in the same profile with the worker still installed and in control,
  all 13 initial CDN requests went from the page straight to the network (where the blocker
  failed them). The worker handled none.
- **`?offline=false`** took the registration count from 1 to 0, and a flagless load
  afterwards didn't register it again.

**`Network.setBlockedURLs` can't test a service worker.** On the page target it blocks
requests _before_ the worker sees them (`blockedReason: "inspector"`), so the deck fails even
when every file is on disk. Use `Fetch.enable({ patterns: [{ urlPattern: "*" }] })` on the page
**and** on the service worker target (it's in `/json/list` as `type: "service_worker"`). Then
`Fetch.failRequest` anything that isn't localhost. That runs at the network layer, after the
worker, so it catches exactly the requests that would really leave the machine.
`emulateNetworkConditions({ offline: true })` is still untested.

**Pre-existing, not offline-related:** `deck/code-editor.js` fails to import, online as well,
with `'/npm/@jridgewell/sourcemap-codec@1.5.3/+esm' does not provide an export named 'encode'`.
react-live@5.0.0 → sucrase → `@jridgewell/gen-mapping` imports named exports, and jsDelivr
builds sourcemap-codec 1.5.3 from its UMD file, which has only a default export. No slide
renders `CodeEditor`, so nothing breaks today. The day a slide uses it, a prefix remap from
`…/sourcemap-codec@1.5.3/` to `1.5.4/` fixes it: 1.5.4 is already in the graph, and its ESM
build has the named exports.

**Running it inside Claude Code's sandbox:** Node's `fetch` ignores `HTTPS_PROXY`, so set
`NODE_USE_ENV_PROXY=1`. No CDP Chrome was running, and `npm run cdp` uses `open`, which the
sandbox blocks. Launching the Chrome binary directly with `--headless=new
--remote-debugging-port=1980 --user-data-dir=<scratch>` works.

### Phase 2 — models

**Delivers:** `npm run offline:model` downloads to `offline/models/` with resume (`curl -C -`)
and a size check against `EXPECTED_BYTES`. The service worker maps the HuggingFace URL in
`chat/agent/providers/litert.js` to that file.

- Nothing in `litert-cache.js` changes. On a cache miss the page fetches the HF URL, the
  service worker streams the local file back, and the existing path caches it. **The service
  worker must set `content-length`**, because that header is the truncation check.
- The page gets a `Blob`, so no Range handling is needed. Don't buffer: pipe `body` through.
- **Result:** a fresh or wiped profile re-fills from disk in seconds instead of downloading
  2 GB over venue wifi.
- **Gemini Nano can't be vendored.** Chrome owns it. Add `npm run cdp:talk`, which launches
  with a **persistent** profile (e.g. `~/.cache/tfsb-chrome-talk`) that `cdp:stop` never
  deletes. Download Nano there once and check `chrome://on-device-internals`.

**Done when:** you wipe the talk profile, go offline, open the assistant, load Gemma from disk,
and get an answer.

### Phase 3 — demo videos (independent)

**Delivers:** videos committed as `media/videos/<demo-id>.mp4` (plus an optional `.jpg`
poster), a registry that maps slides to videos, a hotkey, and a deck-chrome button next to the
tools/chat toggles that **appears only on slides that have a backup configured**.

- **Registry:** a `deck/demos.js` map, or a prop on the demo slide's component. Decide in the
  session after reading how `deck/components.js` identifies slides; `chat/harvest/` already
  reads slide identity from the fiber tree.
- **Button:** the tools/chat toggles are `Toggle` in `chat/ui/toggle.js`, and `chat/` is meant
  to stay self-contained. Either move `Toggle` somewhere shared, or give the deck its own
  button with the `.chat-toggle` look. Keep `pointer-events: auto` (see that file's comment).
- **Overlay:** a fullscreen `<video>` over the slide. Watch for key conflicts: Space and the
  arrow keys must control the video, not advance the slide. Check `deck/slide-keys.js` for a
  free hotkey (`v`?) and for how keys are already intercepted.
- **Encoding** (target a few MB per minute):
  `ffmpeg -i in.mov -c:v libx264 -crf 26 -preset slow -vf scale=-2:1080 -an -movflags +faststart out.mp4`
  Drop `-an` if a video needs audio. `+faststart` makes playback start before the whole file
  has loaded.
- Videos are same-origin, so they need nothing from phases 1–2 and work on GitHub Pages too.
  `serve` handles Range requests, so seeking works locally.

**Done when:** on a demo slide the button shows up, the hotkey and the button both play the
video, Esc closes it, and slides without a backup show no button.

### Phase 4 — pre-flight check, tooling and skill

**Delivers:**

- `npm run offline:check`. Over CDP, with every external host blocked, it confirms the service
  worker is in control, walks every slide, opens the assistant, loads Gemma, asks one question,
  and **fails on any blocked or failed request** with a list of the URLs. Block with the
  `Fetch` domain on the page and service worker targets, **not** `Network.setBlockedURLs`,
  which blocks before the worker. Phase 1's "Verified" note has the details.
- `serve` and `@mcp-b/webmcp-local-relay@5.1.0` as pinned devDependencies, with `dev` and
  `demo:relay` pointing at the local bins, so neither needs npx over the network.
- Finish `docs/offline.md`: make every command real, add what to do when `offline:check`
  reports misses, and remove the "planned" banner. Keep it terse and written for the
  presenter.
- A **Claude skill**, `.claude/skills/offline-prep/`, as a thin wrapper: it runs `offline:fetch`
  → `offline:model` → `offline:check`, reads the report, and fixes or explains each miss. The
  logic stays in the scripts; the skill just runs them. (The sandbox blocks Claude from writing
  under `.claude/skills/`, so you'll need to approve that write or create the file yourself.)
- The final test is manual: **turn wifi off** and run the talk.

### Phase 5 — web-agents and vector-search-web on localhost (estimate only)

These repos are outside this session's sandbox, so these estimates come from memory of how
such apps are usually built, not from reading their code. Verify before relying on them.

- **Serving them:** both are already static GitHub Pages apps. `npm run build`, then serve the
  output on a **fixed port** each (e.g. :4000, :4001). **Effort: low.** Web-agents already
  switches vector-search-web to localhost.
- **Their models:** this is where the work is. If they use transformers.js or WebLLM, both
  already cache weights in the Cache API. One warm-up in the talk profile, on the same origin
  (same port — the origin includes the port), may be all that's needed. **Effort: low if so.**
  If they also pull wasm or JS from a CDN at runtime, copy `sw.js` plus a manifest into each
  app. The same recorder works because it is URL-driven. **Effort: medium, about half a day
  each.**
- **Pain:** anything that calls a cloud LLM or an API key provider can't go offline and falls
  back to video. Keeping three origins' caches warm in one profile is the main operational
  risk. `offline:check` could take a list of URLs to cover them too.
- **Overall:** roughly 1–2 days for both, most of it verification. Do it only after phase 4,
  and only if a live demo matters more than the video.

---

## 4. Handoff prompts

Paste one per new session. Each assumes the previous phases are merged.

**Phase 1**

> Read `docs/handoffs/offline-handoff.md` §1–§3 (phase 1) and `docs/dependencies.md`. Build `sw.js`
> (localhost-only registration from `index.html`, synthetic responses, network fall-through)
> and `scripts/offline-fetch.mjs` (CDP recorder reusing `test/cdp.js`, headers-preserving
> re-fetch, import-map closure check), wired as `npm run offline:fetch`, with `offline/`
> gitignored. Find out what `LiteRtLm.DEFAULT_WASM_PATH` loads and vendor it. Verify with every
> external host blocked over CDP. Update §3 phase 1 in the handoff doc with what you learned, and `docs/offline.md` if a command changed.

**Phase 2**

> Read `docs/handoffs/offline-handoff.md` (phase 2) and `chat/agent/providers/litert-cache.js`. Add
> `npm run offline:model` (resumable, size-checked) and a service worker mapping from the
> HuggingFace model URL to `offline/models/`, streaming with `content-length`. Add
> `npm run cdp:talk` with a persistent profile. Verify a wiped profile loads Gemma offline.

**Phase 3**

> Read `docs/handoffs/offline-handoff.md` (phase 3). Build backup demo videos: a registry of
> slide → `media/videos/*.mp4`, a deck-chrome button next to the tools/chat toggles shown only
> on slides with a backup, a hotkey, and a fullscreen overlay whose keys don't advance the
> deck. Use a short placeholder mp4 until real recordings exist.

**Phase 4**

> Read `docs/handoffs/offline-handoff.md` (phase 4). Build `npm run offline:check` (CDP, external hosts
> blocked, full walk plus a Gemma answer, fails with a list of missed URLs). Pin `serve` and the
> relay as devDependencies. Finish `docs/offline.md` (presenter-facing, terse). Draft the `offline-prep` skill.
