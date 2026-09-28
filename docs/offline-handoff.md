# Offline mode — plan and handoffs

Goal: present the whole talk with wifi off. The deck, its assistant, its images and the backup
demo videos all come from the laptop. **Local dev only**: nothing here has to work on GitHub
Pages, and nothing here may change how the published deck behaves.

Status: **planned, nothing built.** Each phase below is sized for one session and ends with a
handoff prompt you can paste into a new session.

---

## 1. What leaves the machine today

| What                                  | From                                   | Loaded when                                  |
| ------------------------------------- | -------------------------------------- | -------------------------------------------- |
| ~870 ES modules (React, Spectacle, …) | `cdn.jsdelivr.net`, via the import map | every load                                   |
| Phosphor icon CSS + its font files    | `cdn.jsdelivr.net`                     | every load                                   |
| Inter / Fira Code                     | `fonts.googleapis.com` → `gstatic.com` | every load                                   |
| Slide backgrounds                     | `images.unsplash.com`                  | when a slide is shown                        |
| Nearform logo                         | `encrypted-tbn0.gstatic.com`           | every load                                   |
| `@litert-lm/core` wasm (19–31 MiB)    | `cdn.jsdelivr.net/…/wasm`              | first Gemma load                             |
| Gemma 4 E2B, 2,008,432,640 bytes      | `huggingface.co`                       | download click, then cached in the Cache API |
| Gemini Nano (Prompt API)              | Chrome itself                          | browser-managed, per profile                 |
| `serve`, `@mcp-b/webmcp-local-relay`  | npm, via `npx`                         | `npm run dev`, `npm run demo:relay`          |

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
  ([dependencies.md §4](dependencies.md#4-the-react-singleton-rule)) breaks.
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
`location.hostname` is `localhost` or `127.0.0.1`. On GitHub Pages the file is published but
never registered.

When a dependency is bumped, a URL that isn't in the manifest just goes to the network. A stale
`offline/` directory therefore degrades to "online as usual", not to a broken deck.

---

## 3. Phases

```
 Phase 1  SW + CDP recorder (JS/CSS/fonts/images/wasm) ──► Phase 2  model ──► Phase 4  check + skill
 Phase 3  demo videos (independent: run it any time, in parallel)
 Phase 5  external demo sites (estimate only, later)
```

### Phase 1 — service worker and the "load" recorder

**Delivers:** `sw.js`, the registration snippet in `index.html`, `scripts/offline-fetch.mjs`,
`npm run offline:fetch`, and `offline/` in `.gitignore`.

**The recorder uses CDP and follows your "load the page and infer everything" idea.** It
attaches to the running Chrome with the helpers in `test/cdp.js` (extract a shared module if
needed), then:

1. `Network.setBypassServiceWorker(true)` and `Network.enable`, so every request goes to the
   network and shows up.
2. Loads the deck, walks **every slide** (backgrounds only load when a slide is shown), and
   opens the chat panel so its lazy import runs.
3. Collects every request to a non-localhost host, together with the request headers the
   browser sent.
4. Re-fetches each URL from Node **with those headers**. Google Fonts CSS depends on the
   User-Agent, so Chrome's UA is needed to get woff2. It then writes `files/` and
   `manifest.json`.
5. **Closure check:** scans every vendored JS body for `/npm/…` specifiers, resolves them
   through the import map, and fails if any resolved URL is missing. Walking the slides can't
   trigger code nothing renders (e.g. `deck/code-editor.js`'s react-live chunk), and this check
   catches those gaps.

**Open question to settle in this session:** which files `LiteRtLm.DEFAULT_WASM_PATH` actually
loads (JS glue plus one or more `.wasm`, possibly one per backend). Two options: read the
package to find out, or have the recorder load the model for real in a profile that already has
it cached. The second is slower but exact.

**Done when:** with the service worker active and `Network.setBlockedURLs` blocking every
external host, the deck loads and every slide renders with its icons, fonts and background.

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
  and **fails on any blocked or failed request** with a list of the URLs. (Prefer
  `Network.setBlockedURLs` over `emulateNetworkConditions({ offline: true })`. It's unverified
  whether the latter also blocks the service worker's own localhost fetches.)
- `serve` and `@mcp-b/webmcp-local-relay@5.1.0` as pinned devDependencies, with `dev` and
  `demo:relay` pointing at the local bins, so neither needs npx over the network.
- A `docs/offline.md` runbook: the night before, at the venue, and what to do when something is
  red. It links from `dependencies.md` §3's existing pre-flight note.
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

> Read `docs/offline-handoff.md` §1–§3 (phase 1) and `docs/dependencies.md`. Build `sw.js`
> (localhost-only registration from `index.html`, synthetic responses, network fall-through)
> and `scripts/offline-fetch.mjs` (CDP recorder reusing `test/cdp.js`, headers-preserving
> re-fetch, import-map closure check), wired as `npm run offline:fetch`, with `offline/`
> gitignored. Find out what `LiteRtLm.DEFAULT_WASM_PATH` loads and vendor it. Verify with every
> external host blocked over CDP. Update §3 phase 1 in the handoff doc with what you learned.

**Phase 2**

> Read `docs/offline-handoff.md` (phase 2) and `chat/agent/providers/litert-cache.js`. Add
> `npm run offline:model` (resumable, size-checked) and a service worker mapping from the
> HuggingFace model URL to `offline/models/`, streaming with `content-length`. Add
> `npm run cdp:talk` with a persistent profile. Verify a wiped profile loads Gemma offline.

**Phase 3**

> Read `docs/offline-handoff.md` (phase 3). Build backup demo videos: a registry of
> slide → `media/videos/*.mp4`, a deck-chrome button next to the tools/chat toggles shown only
> on slides with a backup, a hotkey, and a fullscreen overlay whose keys don't advance the
> deck. Use a short placeholder mp4 until real recordings exist.

**Phase 4**

> Read `docs/offline-handoff.md` (phase 4). Build `npm run offline:check` (CDP, external hosts
> blocked, full walk plus a Gemma answer, fails with a list of missed URLs). Pin `serve` and the
> relay as devDependencies. Write `docs/offline.md`. Draft the `offline-prep` skill.
