# Offline mode — plan and handoffs

Goal: present the whole talk with wifi off. The deck, its assistant, its images and the backup
demo videos all come from the laptop. **Local dev only**: nothing here has to work on GitHub
Pages, and nothing here may change how the published deck behaves.

Status: **phases 1, 2 and 4 built** (service worker, `offline:fetch`,
`offline:model`, `cdp:talk`, `offline:check`, pinned `serve` and relay, the `offline-prep` skill). Phase 4 is verified, including a wifi-off run. Phases 3 and 5 are planned. Each phase below is sized for one session and ends with a
handoff prompt you can paste into a new session.

**Two docs, two readers.** This file is for whoever builds the feature.
[`../offline.md`](../offline.md) is for the presenter: terse, commands and steps only. Every
phase that changes a command or a step updates `offline.md` in the same change, and removes
its "planned" banner once phase 4 lands (done).

---

## 1. What leaves the machine today

| What                                               | From                                     | Loaded when                                  |
| -------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| ~870 ES modules (React, Spectacle, …)              | `cdn.jsdelivr.net`, via the import map   | every load                                   |
| Phosphor icon CSS + its font files                 | `cdn.jsdelivr.net`                       | every load                                   |
| Inter / Fira Code                                  | `fonts.googleapis.com` → `gstatic.com`   | every load                                   |
| Slide backgrounds                                  | `images.unsplash.com`                    | when a slide is shown                        |
| Nearform logo                                      | `encrypted-tbn0.gstatic.com`             | every load                                   |
| `@litert-lm/core` wasm (one of 4 builds, 21–34 MB) | `cdn.jsdelivr.net/…/wasm`                | first Gemma load                             |
| Gemma 4 E2B, 2,008,432,640 bytes                   | `huggingface.co`                         | download click, then cached in the Cache API |
| Gemini Nano (Prompt API)                           | Chrome itself                            | browser-managed, per profile                 |
| `serve`, `@mcp-b/webmcp-local-relay`               | npm, via `npx` (pinned locally, phase 4) | `npm run dev`, `npm run demo:relay`          |

Two risks already exist today, before any of the new work:

- **`npm run cdp:stop` runs `rm -rf /tmp/tfsb-chrome-cdp`.** That deletes the cached Gemma
  model, Gemini Nano, and (once it exists) the service worker. Don't present from that profile;
  use `npm run cdp:talk` (phase 2).
- **`npx serve` without network** only worked if npx happened to have it cached. Fixed in phase 4: both are devDependencies now.

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
  models.json          the same shape, for the model; written by `offline:model`
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
  this; it wasn't chosen, so that you always opt in explicitly. **Fixed after phase 4**, see
  "Mode switches keep `?offline`" there.
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

The first two checks are in [`scripts/offline-check.mjs`](../../scripts/offline-check.mjs)
(`--shots` saves screenshots to `offline/verify/`, `--no-flag` runs the inverse check). It is
(then `offline-verify.mjs`; phase 4 renamed it and wired it as `npm run offline:check`). On a brand-new profile it passes both
ways: with the flag, 184 external responses, all from the worker; without it, 10 requests reach
the network and are blocked.

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

### Phase 2 — models ✅ done

**Delivered:**

- `npm run offline:model` (`scripts/offline-model.mjs`). It reads the repo, file name and
  `EXPECTED_BYTES` out of `chat/agent/providers/litert.js` with regexes, because that module
  imports `@litert-lm/core` and can't load in Node. Then it runs
  `curl -L --fail --retry 5 -C - -o offline/models/<file>`. A file that is already the right
  size is skipped, and one that is too big is deleted and fetched again. Only when the size
  matches does it write `offline/models.json`; otherwise it deletes that file and exits 1.
- **`offline/models.json`, not an entry in `manifest.json`.** `offline:fetch` rewrites its
  manifest from scratch on every run, so it would drop the model. The two files have the same
  `{ url → { file, type, bytes } }` shape. `sw.js` loads both at startup and on each
  navigation and merges them, so `answer()` didn't change. The model is served with
  `content-length` from `bytes` and its body piped, the same as every other entry, and only
  for `?offline` pages.
- `npm run cdp:talk`: the `cdp` command with `--user-data-dir=$HOME/.cache/tfsb-chrome-talk`.
  `cdp:stop` matches `tfsb-chrome-cdp`, so it neither kills nor deletes the talk profile. Both
  used port 1980, so only one could run at a time; phase 4 moved `cdp:talk` to :1981. To quit
  the talk Chrome, close it normally.
- `scripts/offline-verify.mjs --gemma` (now `offline-check.mjs`, Gemma by default): after the walk, with the blocks still on, it imports
  the deck's `litert.js`, calls `provider.acquire()` and streams one answer. It runs inside the
  page and is polled, because `test/cdp.js` caps every call at 5 s. It reports the provider's
  status beforehand (`downloadable` means the 2 GB really came through the worker), the ms at
  which the download and engine phases started, the answer, and whether the `.litertlm`
  response came from the service worker. It fails without an answer.

**Tested:**

- The first download took under two minutes (about 20 MB/s) and matched `EXPECTED_BYTES`.
- A re-run with the file complete skips curl.
- Cutting the file to 2,008,000,000 bytes and re-running resumed and fetched only the
  remaining ~430 KB.
- `serve` answers the model with `Content-Length: 2008432640` and no compression.
- `npm run format` is clean.

**Verified on a wiped talk profile** (`cdp:talk`, so a headed Chrome), with every external
host blocked on the page and worker targets:

```sh
npm run dev
npm run cdp:stop    # frees :1980; otherwise the check attaches to the old Chrome
rm -rf ~/.cache/tfsb-chrome-talk && npm run cdp:talk
CDP_URL=http://127.0.0.1:1980 node scripts/offline-verify.mjs --gemma
```

- Before the load, the status was `downloadable`: the profile had no cached model.
- The model's response was a 200 **from the service worker**. The 2 GB copy into the Cache
  API took **3.4 s**, the GPU load took about 1 s, and the answer came after about 4.8 s in
  total.
- All 29 slides walked. 185 external responses (184 plus the model) all came from the worker,
  with nothing blocked, no failed requests and no console errors.
- On a profile with the model already cached, the same check loads it in about 1 s. It then
  prints a note, because a cache hit doesn't touch `offline/models/`.

**Gotchas found while verifying:**

- **`CDP_URL` is required** when running the script with `node`: `test/cdp.js` defaults to
  :9222, and only the npm scripts set it. The `offline:check` npm script (phase 4) sets it.
- **Port collision** (fixed in phase 4 by giving `cdp:talk` its own port, :1981). If a `cdp`
  Chrome is still on :1980, `cdp:talk` can't take the port, and the check silently runs
  against the old profile. The first run did exactly that and reported `before: 'on-disk'`.
- **LiteRT logs through `console.error`.** Its wasm writes `INFO:`/`WARNING:` lines to
  stderr, which Emscripten turns into `console.error`. The script ignores those two prefixes
  and still counts `ERROR:` lines.
- **Launching Chrome from Claude's sandbox no longer works.** Phase 1 launched the binary
  directly. This time Chrome aborted with "Failed to create socket directory": its process
  singleton lives in `/var/folders/…/T`, which the sandbox denies, and `TMPDIR` doesn't change
  that. Auto mode refused an unsandboxed launch, so the presenter ran the check. For phase 4,
  either do the same, or allow Chrome launches outside the sandbox (`/sandbox`, or a Bash
  permission rule).

The original plan, kept for reference:

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
- **The recordings** will be silent macOS screen recordings (⇧⌘5 → `.mov`), made later. They
  are HiDPI and text-heavy, so they're large, and small text must stay readable. No audio, so
  the `<video>` is `muted` (which also lets it autoplay) with no audio track to keep.
- **An encode script** so adding a real recording is one command, e.g.
  `npm run video:add -- ~/Desktop/rec.mov <demo-id>` → `media/videos/<demo-id>.mp4` (H.264,
  no audio, `+faststart` so playback starts before the whole file loads, at least 1080p tall
  for readable text, 30 fps) plus a `.jpg` poster. Target a few MB per minute. **`ffmpeg`
  isn't installed**; macOS has `/usr/bin/avconvert` (presets, H.264/HEVC) and `qlmanage -t`
  (a thumbnail, usable as a poster). Try those first and check that the output plays in Chrome
  and starts fast. Ask before `brew install ffmpeg`. With ffmpeg the encode would be
  `ffmpeg -i in.mov -c:v libx264 -crf 23 -preset slow -vf scale=-2:1080,fps=30 -an -movflags +faststart out.mp4`.
- **Commit or not:** ask. Committed videos also work on GitHub Pages (same-origin), but they
  bloat the repo (GitHub rejects files over 100 MB, and Pages doesn't serve LFS). The
  alternative is gitignoring `media/videos/` and keeping them local-only.
- **A missing file must not break a slide.** Real videos come later, so a registry entry may
  point at a file that isn't there yet. Decide between hiding the button and showing an error
  in the overlay, and make `offline:check` report every registered video that 404s on
  localhost (a plain `fetch` from Node, no CDP needed).
- **Placeholder:** a few seconds recorded from a `<canvas>` with `MediaRecorder` in Chrome
  (webm), or generated by whatever encoder the script uses. It's only there so the button,
  hotkey and overlay can be tested.
- Videos are same-origin, so `sw.js` leaves them alone and they need nothing from phases 1–2.
  `serve` handles Range requests, so seeking works locally.
- **`docs/offline.md`:** put back the "When a live demo fails" section (phase 4 removed it),
  and add how to record and add a video.

**Done when:** on a demo slide with a placeholder the button shows up, the hotkey and the
button both play the video, Space and the arrows control the video and not the deck, Esc
closes it, slides without a backup show no button, a registered-but-missing video is handled
as decided, and `video:add` turns a sample `.mov` into a playable mp4 and poster.

### Phase 4 — pre-flight check, tooling and skill ✅ done

**Delivered:**

- **`npm run offline:check`** (`scripts/offline-check.mjs`, renamed from `offline-verify.mjs`
  with `git mv`). The npm script sets `CDP_URL=${CDP_URL:-http://127.0.0.1:1981}`, the talk
  Chrome. It still loads with `?offline` and blocks with the `Fetch` domain on the page and
  worker targets.
  - **Gemma is part of the default run.** `--gemma` is gone; `--no-gemma` skips it (no GPU,
    or in a hurry). `--no-flag` implies `--no-gemma`, since the deck isn't expected to
    mount.
  - **One list of missed URLs, uncapped.** Blocked and failed requests are merged by URL (a
    blocked request also fires `loadingFailed`, so it would otherwise show twice). Each line
    gives the reason, the target (`page` or `sw`), and whether `offline/manifest.json` or
    `models.json` has that URL. That last part tells the two fixes apart: `not in offline/`
    means re-run `offline:fetch`/`offline:model`; `in offline/` means the worker didn't
    answer. Two hint lines under the list say the same. Console errors stay capped at 40.
  - PASS still needs: deck ready, zero missed URLs, zero console errors and, unless
    `--no-gemma`, a Gemma answer.
- **`serve@14.2.6` and `@mcp-b/webmcp-local-relay@5.1.0`** as exact-pinned devDependencies.
  `dev` is `serve`, and `demo:relay` is `webmcp-local-relay --port 9333`. npm puts
  `node_modules/.bin` on `PATH`, so neither needs npx. Both bins were run from the sandbox.
  With no network, `serve` prints "Checking for updates failed" and carries on.
  (`dep:check` still uses `npx npm-check-updates`, which is only run online.)
- **Two CDP ports.** `config.cdp_talk_port` is `1981`. `cdp:talk`, `offline:fetch` and
  `offline:check` use it; `cdp` and `npm test` stay on `cdp_port`, 1980. This removes the
  silent collision above, so prep no longer needs `cdp:stop`, and a throwaway Chrome can stay
  open for `npm test` alongside the talk one. Point `CDP_URL` at :1980 to check a throwaway
  profile. A talk Chrome started before this change still listens on :1980; quit it and
  relaunch (`cdp:talk` now says so, below).
- **`docs/offline.md`** is finished: no banner, every command exists, a "When
  `offline:check` fails" table, and the `offline:check` flags. The
  backup-video section was dropped because nothing in it exists yet. **Phase 3 must add it
  back.**
- **`.claude/skills/offline-prep/SKILL.md`**: runs the three scripts in order (fetch with
  `NODE_USE_ENV_PROXY=1`), stops at the first failure, and has a table mapping each kind of
  missed-URL line to a cause and a fix. It asks the presenter to start `dev` and `cdp:talk`,
  and to run a step and paste its output if the sandbox can't reach :1981. The write was
  approved by hand.
- Comment references in `eslint.config.js` and `test/cdp.js` follow the rename and drop
  `npx serve`.

**Follow-ups, added after verification:**

- **`cdp:talk` detects a running talk Chrome** (in response to step 1).
  If `pgrep -f 'tfsb-chrome-[t]alk'` finds one and :1981 answers, it prints "already running"
  and exits 0 without launching. If one is running but :1981 is silent (the step 1 case), it
  prints the `pkill -f tfsb-chrome-talk` fix and exits 1. Otherwise it launches as before. The
  `[t]` keeps the pattern from matching the npm shell's own command line. Tested: the first
  two branches (the second by running the script with the port set to an unused one); the
  launch branch is the unchanged `open` command.
- **Mode switches keep `?offline`.** Spectacle's `toggleMode` (keyboard
  shortcuts and the command bar, for every mode, in and out) does
  `window.location.search = stringify({ slideIndex, stepIndex, ...modeFlag })`, which drops
  every other param. There's no hook to change that, so the `<head>` snippet in `index.html`
  now handles it: a page with no `offline` param whose `document.referrer` is same-origin and
  has one does `location.replace()` with that value put back. A typed URL has no referrer and
  `?offline=false` is an explicit value, so opt-in stays explicit. No `Referrer-Policy` is set
  (HTML or `serve`), so same-origin referrers keep their query. Cost: one extra local page
  load per mode switch; the aborted load sent nothing to the network. **Tested** on the talk
  Chrome over CDP, cache off, by assigning the exact strings Spectacle builds: presenter in,
  presenter out and overview in each came back with `?offline`, and all 173 jsDelivr
  responses came from the worker (0 from the network). A typed flagless URL stayed flagless,
  with all 254 from the network. Not tested: the real keyboard shortcut (same code path).
- **`test/cdp.js`'s "no CDP" message** now names both: `npm run cdp` (tests) or
  `npm run cdp:talk` (offline scripts). Checked with `offline:check` pointed at an unused
  port.

**Verified:** `npm run format` and `node --check` are clean. Chrome can't be launched from the
sandbox (phase 2's gotcha), so the presenter ran every Chrome step below and pasted the output.

**Results:**

- **Step 1.** The first `cdp:talk` gave an empty `curl :1981`. A talk Chrome from before the
  port change was still running on :1980. Chrome allows one process per profile, so the new
  launch was handed to it and `--remote-debugging-port=1981` was ignored. After
  `pkill -f tfsb-chrome-talk` and a fresh `cdp:talk`, :1981 answered. `cdp:talk` now detects
  this case (follow-ups above).
- **Step 2, talk profile: PASS.** 29 slides; 184 external responses, all from the worker;
  0 missed URLs; 0 console errors; fonts Inter, Fira Code, Phosphor, Phosphor-Fill; LiteRT
  runtime in 57 ms. Gemma was `on-disk` (cached, so `offline/models/` wasn't exercised):
  loaded in 949 ms, answered at 1,347 ms.
- **Step 3 skipped.** Phase 2 already verified a fresh profile loading the model from disk,
  and `sw.js`, `offline:model` and the Gemma path are unchanged. Step 6 covers the
  side-by-side ports. Re-run it when `sw.js`, `offline/models/` or the LiteRT version changes.
- **Step 4, `--no-flag`: PASS.** Not ready, 0 slides, 0 external responses. 10 missed URLs,
  all `blocked, in offline/  page` (2 Google Fonts CSS, 2 Phosphor CSS, react, react-dom,
  htm, spectacle, styled-components, @emotion/is-prop-valid). No hint lines, as intended
  without the flag.
- **Step 5, manifest moved aside: FAIL, as intended.** With `?offline` but no manifest, the
  same 10 URLs were `blocked, not in offline/  page`, and the `offline:fetch` hint printed.
  Nothing went through the worker, which confirms a missing manifest falls through to the
  network rather than breaking the worker. Manifest restored afterwards.
- **Step 6, both Chromes at once: PASS.** `npm test` passed against a throwaway `cdp`
  Chrome on :1980 while the talk Chrome held :1981. No `cdp:stop` was needed: nothing was on
  :1980 after the talk Chrome moved.
- **Step 7, wifi off: works.** The presenter ran `dev` and `cdp:talk` with no network, opened
  `/?offline`, walked the deck and used the assistant.

**To re-verify later** (steps as numbered above):

- 2: `npm run offline:check` on the talk Chrome.
- 3, when `sw.js`, the model or LiteRT changes: `npm run cdp`, then
  `CDP_URL=http://127.0.0.1:1980 npm run offline:check`, expecting `before: 'downloadable'`
  and the model from the worker.
- 4: `npm run offline:check -- --no-flag`, expecting `PASS` with ~10 `blocked, in offline/`.
- 5: `mv offline/manifest.json offline/manifest.json.bak`,
  `npm run offline:check -- --no-gemma` (expect `FAIL`, `not in offline/`, the hint), then
  move it back.
- 7: wifi off, per `docs/offline.md` "At the venue".

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

Paste one per new session. Each assumes the previous phases are committed on the
`infra/offline` branch, where all of this work stays until it's done.

**Phase 1** ✅ done. The prompt is kept for the record.

> Read `docs/handoffs/offline-handoff.md` §1–§3 (phase 1) and `docs/dependencies.md`. Build `sw.js`
> (localhost-only registration from `index.html`, synthetic responses, network fall-through)
> and `scripts/offline-fetch.mjs` (CDP recorder reusing `test/cdp.js`, headers-preserving
> re-fetch, import-map closure check), wired as `npm run offline:fetch`, with `offline/`
> gitignored. Find out what `LiteRtLm.DEFAULT_WASM_PATH` loads and vendor it. Verify with every
> external host blocked over CDP. Update §3 phase 1 in the handoff doc with what you learned, and `docs/offline.md` if a command changed.

**Phase 2** ✅ done. The prompt is kept for the record.

> Read `docs/handoffs/offline-handoff.md` (§2, phase 1's notes, and phase 2),
> `chat/agent/providers/litert-cache.js`, `sw.js` and `scripts/offline-verify.mjs`.
>
> - Add `npm run offline:model`: downloads to `offline/models/`, resumable with `curl -C -`, and
>   checked against `EXPECTED_BYTES`.
> - Make `sw.js` map the HuggingFace model URL to that file, piping the body and setting
>   `content-length`. It must still answer only for `?offline` pages.
> - Add `npm run cdp:talk`: the same flags and CDP port as `cdp`, with a persistent profile that
>   `cdp:stop` never deletes.
> - Verify that a wiped profile loads Gemma from disk with every external host blocked. Extend
>   `offline-verify.mjs` rather than writing a new check.
> - In Claude's sandbox: run Node with `NODE_USE_ENV_PROXY=1`, and launch the Chrome binary
>   directly, because `open` is blocked.
> - Update phase 2 in the handoff and `docs/offline.md`.

**Phase 3** (rewritten after phase 4)

> Read `docs/handoffs/offline-handoff.md` phase 3 and `docs/offline.md`, then build phase 3:
> backup demo videos. No real recordings exist yet, so build the setup and test it with a
> placeholder. The recordings will be silent macOS screen recordings (`.mov`, HiDPI, small
> text).
>
> - Registry of slide → `media/videos/<demo-id>.mp4`. Decide `deck/demos.js` vs a prop after
>   reading how `deck/components.js` and `chat/harvest/` identify slides.
> - Button next to `ChatToggle`/`ToolsToggle`, only on slides with a backup (reuse `Toggle` or
>   match `.chat-toggle`). A hotkey (check `deck/slide-keys.js`). A fullscreen muted `<video>`
>   overlay: Space and the arrows control the video, not the deck, and Esc closes it.
> - A registered video whose file is missing must not break the slide. Propose how it shows,
>   and make `offline:check` list every registered video that 404s.
> - `npm run video:add -- <file.mov> <demo-id>`: encode to a small, fast-starting, readable
>   H.264 mp4 with no audio, plus a poster. `ffmpeg` isn't installed, so try macOS's
>   `avconvert` and `qlmanage` first, and ask before installing anything.
> - Ask me whether videos get committed or gitignored before creating `media/videos/`.
> - Put back the "When a live demo fails" section in `docs/offline.md`, and add how to add a
>   recording.
>
> I start `npm run dev` and `npm run cdp:talk` (:1981), run browser steps and paste output, and
> record a throwaway `.mov` when `video:add` needs one. Update phase 3 in the handoff.

**Phase 4** ✅ built. The prompt is kept for the record.

> Read `docs/handoffs/offline-handoff.md` (phase 1's notes and phase 4). Grow
> `scripts/offline-verify.mjs` into `npm run offline:check`: `?offline`, external hosts blocked
> with the `Fetch` domain on the page and worker targets, a full walk plus a Gemma answer, and a
> failure with a list of missed URLs. Pin `serve` and the relay as devDependencies. Finish
> `docs/offline.md` (presenter-facing, terse). Draft the `offline-prep` skill.
