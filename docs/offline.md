# Offline mode

Present the talk with no network. Works on `localhost` only; the published site is unaffected.
Implementation notes: [handoffs/offline-handoff.md](handoffs/offline-handoff.md).

The deck runs fully offline. The live demos don't: they load from their live sites, and the
Claude Desktop one calls a cloud model. Each has a [backup recording](#when-a-live-demo-fails)
or needs one.

## Talk day, in order

Three terminals. Each command is safe to re-run.

```sh
npm run dev          # 1: serve the deck on :3000 (leave running)
npm run demo:relay   # 2: the WebMCP relay on :9333, for Claude Desktop (leave running)
npm run cdp:talk     # 3: the talk Chrome, CDP on :1981
npm run talk:open    # 3: the deck with ?offline, plus a tab per demo
```

Then:

1. Open Claude Desktop and check it sees the page ([The relay](#the-relay-claude-desktop-demo)).
2. Walk the deck once. The assistant's status should read "on disk".
3. Click through each demo tab once, so it's loaded before you need it.

Start `demo:relay` **before** `talk:open`. The Claude Desktop tab looks for the relay once,
when it loads. If the relay came up later, reload that tab.

With no wifi: everything above still works for the deck, but the demo tabs and Claude
Desktop won't load. Use the backup recordings. See [At the venue](#at-the-venue).

## The demos

| Slide (chapter)               | Demo id           | Opens                                                |
| ----------------------------- | ----------------- | ---------------------------------------------------- |
| ChatGPT shops reebok.com      | `chatgpt-desktop` | `www.reebok.com/`                                    |
| Claude Desktop calls our page | `claude-desktop`  | `nearform.github.io/vector-search-web/?present=true` |
| Vector search (2)             | `vector-search`   | `nearform.github.io/vector-search-web/?present=true` |
| Web AI demos (2)              | `web-ai`          | `nearform.github.io/web-ai-demo/`                    |
| Nearform research agents (3)  | `web-agents`      | `nearform.github.io/web-agents/?relay=false`         |

- **On the slide:** the ↗ icon after the URL opens the demo in a new tab. It's there on the
  published deck too.
- **All at once:** `npm run talk:open` opens the deck and a tab per demo URL, in this order,
  then brings the deck tab to the front. The two vector-search-web demos share one tab. It
  skips tabs already open at the same URL. Our own demos open with `banner=false`. It
  **closes** any deck tab without `?offline` (the one `cdp:talk` opens), because that tab is
  blank with no network.
- `?present=true` gives vector-search-web a generic title for the projector.
- `?relay=false` keeps a tab off the relay. Every tab that connects adds its tools to Claude
  Desktop's list, so with two vector-search-web tabs connected Claude sees each tool twice, under
  suffixed names (`search_ed93`, `search_a1b2`). Only the shared vector-search-web tab should
  connect.

The URLs live in `DEMO_LINKS` in `deck/demos.js`. Change them there; the slide icon and
`talk:open` both read it.

`talk:open` needs `npm run dev` and `npm run cdp:talk` running. It says which one is missing.

## The relay (Claude Desktop demo)

Claude Desktop reaches the page through `@mcp-b/webmcp-local-relay`: a local MCP server that
the page connects to over a WebSocket on `127.0.0.1:9333`.

```text
vector-search-web tab ──ws :9333──▶ relay ◀──stdio── Claude Desktop ──▶ cloud model
```

### One-time setup

Claude Desktop starts its own copy of the relay from its config. In Claude Desktop: Settings →
Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "webmcp-local-relay": {
      "command": "<output of `which node`>",
      "args": ["<repo>/node_modules/@mcp-b/webmcp-local-relay/dist/cli.mjs"]
    }
  }
}
```

This runs the version pinned in this repo (5.1.0, the same one the demo pages load). The relay
README's `npx -y @mcp-b/webmcp-local-relay@latest` also works, but it downloads on every launch
and may pick up a newer version. Full paths, because Claude Desktop doesn't load nvm. With nvm,
`which node` changes when you switch Node versions: update the config if you do.

Quit and reopen Claude Desktop after editing it.

### The commands

| Command                   | What it does                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run demo:relay`      | Runs the relay in the foreground on :9333. Ctrl-C stops it.                                                    |
| `npm run demo:relay:ps`   | Lists every process with a socket on :9333: the relay, Claude Desktop's relay, and Chrome's open connection.   |
| `npm run demo:relay:stop` | Stops the relay **listening** on :9333 (a `node` process only). Use it when an old relay is stuck on the port. |

Both relays can run at once. Whichever starts first owns :9333, and the other joins it and
passes calls through, so it doesn't matter whether Claude Desktop or `demo:relay` starts first.
`demo:relay` is the one you can see in a terminal, and stop and restart without touching
Claude Desktop.

### Check it before the talk

1. `npm run demo:relay`, then `npm run talk:open` (or reload the Claude Desktop tab).
2. In the tab's DevTools console, there should be **no** `[webmcp-relay] No local relay on
ws://127.0.0.1:9333` line.
3. In Claude Desktop, ask: "Which WebMCP sources are connected?" It should list **one**
   vector-search-web tab. More than one means another tab is connected: close it, or open it
   with `?relay=false`.
4. Ask one real search question, and watch the page update.

### When the relay fails

| Symptom                                              | Do this                                                                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console says `No local relay on ws://127.0.0.1:9333` | Start `npm run demo:relay`, then reload the tab.                                                                                                                                        |
| `demo:relay` fails because :9333 is in use           | `npm run demo:relay:ps`. If it's an old relay, `npm run demo:relay:stop` and start again. If it's something else (for example a Chrome with `--remote-debugging-port=9333`), quit that. |
| Claude lists no WebMCP tools                         | Claude Desktop didn't start the relay: check the config paths, then quit and reopen Claude Desktop.                                                                                     |
| Claude lists each tool twice, with suffixes          | Two tabs are connected. Close the extra one, or reopen it with `?relay=false`.                                                                                                          |
| Chrome asks to allow access to the local network     | Allow it. Chrome asks public sites before they connect to `127.0.0.1`.                                                                                                                  |

On stage, don't debug: cut to the recording (⇧⌥V).

## Before the trip (on good wifi)

```sh
npm install              # the dev server and the relay, pinned locally
npm run dev              # serve the deck on :3000
npm run cdp:talk         # Chrome with the persistent talk profile, CDP on :1981 (safe to re-run)
npm run offline:fetch    # record and save every CDN file, font and image
npm run offline:model    # download Gemma (2 GB) to offline/models/
npm run offline:check    # walk the deck, ask Gemma and Gemini Nano, external hosts blocked
```

`offline:check` must print **PASS** with `missed URLs: 0` and `missing: 0` backup videos.
Re-run `offline:fetch` after any dependency change.

- `offline:fetch` reuses files it already has; `npm run offline:fetch -- --force` downloads
  everything again. It fails, and lists the URLs, if any file couldn't be saved.
- `offline:model` resumes where it stopped, so if it fails, run it again. It skips the
  download if the file is already complete.
- `offline:check` options: `-- --no-gemma` skips Gemma, `-- --no-nano` skips Gemini Nano,
  `-- --shots` saves a screenshot per slide to `offline/verify/`.
- `offline:check` asks Gemini Nano the Prompt API slide's question. If the talk profile doesn't
  have the model yet, that starts Chrome's download (several GB) and waits up to 15 minutes, so
  run it on good wifi the first time.

In the talk profile, also:

- Ask one question on **each** provider.
- Run `npm run talk:open` and load each demo once. The service worker installs from the
  `?offline` deck tab, and each demo's first load (models included) happens on good wifi.
- Set up and check the relay: [The relay](#the-relay-claude-desktop-demo).

## When `offline:check` fails

Each missed URL says whether `offline/` has a copy.

| It says                         | Do this                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not in offline/`, a CDN URL    | `npm run offline:fetch`, then check again.                                                                                                         |
| `not in offline/`, `.litertlm`  | `npm run offline:model`, then check again.                                                                                                         |
| `in offline/`                   | The worker isn't answering. Reload `/?offline` once and check again. If it persists, open `/?offline=false`, then `/?offline`, to reinstall it.    |
| `service worker not in control` | Same as above: reload once, or reinstall.                                                                                                          |
| Gemma error or `timed out`      | Needs a GPU. Check `offline/models/` has the file, then check again. `-- --no-gemma` gets the rest of the report.                                  |
| Gemini Nano `timed out`         | Chrome is still downloading it: check `chrome://on-device-internals`, then check again. `-- --no-nano` gets the rest of the report.                |
| Gemini Nano `unavailable`       | This device or Chrome can't run it. The Prompt API slide will show the error; use the answer in its speaker notes.                                 |
| `NOTE: the model was cached`    | Not a failure. The profile already had Gemma, so the check didn't test `offline/models/`.                                                          |
| `no CDP at …:1981`              | `npm run cdp:talk`. If it says the talk Chrome is on another port: `pkill -f tfsb-chrome-talk` (keeps the profile), then `npm run cdp:talk` again. |
| `backup videos: … missing: N`   | Record that demo and add it: [Add a recording](#add-a-recording).                                                                                  |

Still failing after `offline:fetch`? A missed URL that `offline:fetch` doesn't save is a bug in
the recorder: note the URL and see the handoff.

## The `?offline` flag

| URL              | Effect                                                           |
| ---------------- | ---------------------------------------------------------------- |
| `?offline`       | Installs the service worker and serves CDN files from `offline/` |
| no flag          | Loads from the network as usual, even if the worker is installed |
| `?offline=false` | Uninstalls the worker                                            |

`=true` and `=1` also turn it on. Slide changes and Spectacle mode switches (presenter,
overview, print) keep the flag. A typed URL without it loads online.

To check it's working, look at DevTools → Network: CDN rows show **(ServiceWorker)** in the Size
column.

## At the venue

1. If there's no reliable wifi, turn it **off**, so nothing hangs on a half-working network.
2. Run the [talk day](#talk-day-in-order) commands. With wifi off, skip `demo:relay`.
3. If the deck tab is blank, reload it once.
4. Walk the deck once. The assistant's status should read "on disk".

The talk Chrome (`cdp:talk`, :1981) and the throwaway one (`cdp`, :1980, used by `npm test`)
can run side by side. `npm run cdp:stop` quits and **deletes** only the throwaway profile. The
talk profile (`~/.cache/tfsb-chrome-talk`), with its cached models, survives it. Quit the talk
Chrome normally.

`npm run dev` warns "Checking for updates failed" with no network. Ignore it.

## When a live demo fails

On a demo slide with a backup recording, a film-strip button appears after the tools button.
Click it or press **⇧⌥V** to play the recording fullscreen.

| Key      | While the recording is up |
| -------- | ------------------------- |
| Space    | Pause / play              |
| ← / →    | Back / forward 5 seconds  |
| Esc, ⇧⌥V | Close, back to the slide  |

The deck doesn't move while it's up. Only on `localhost`: the published deck has no button.

Every demo slide except the deck-tools bonus demo (the deck itself is the demo) has a
recording slot in `DEMO_VIDEOS` (`deck/demos.js`), so any of them can be swapped for its
video on the day. The slides say "Demo", not "Live demo", so a video reads
as planned. A demo without its file shows "No recording yet" instead.

## Add a recording

1. Record the demo with [OBS](https://obsproject.com) (free). It records one app window,
   and its Stop button stays put. One-time setup:
   - **Settings → Video:** base and output 1920×1080, 30 FPS.
   - **Settings → Output → Recording:** MP4 (or Hybrid MP4). Files land in `~/Movies`.
   - **Sources → + → macOS Screen Capture**, method **Window Capture**, pick the app.
     Right-click it → **Transform → Fit to screen**.
   - Grant Screen Recording in System Settings → Privacy & Security, then restart OBS.

   Then **Start Recording** / **Stop Recording** in the Controls panel. Make the app's text
   bigger first (⌘+), turn on Do Not Disturb, and leave a still second at each end.

   Size the window to 16:9 first, so it fills the frame with no black bars. 1600×900
   points records at 3200×1800 on Retina and scales cleanly to 1920×1080. The first run
   asks to allow your terminal under Privacy & Security → Accessibility:

   ```sh
   # Claude Desktop: name the window. Its "front window" is a hidden 66×20 helper.
   osascript -e 'tell application "System Events" to tell process "Claude" to set size of window "Claude" to {1600, 900}'
   # ChatGPT desktop
   osascript -e 'tell application "System Events" to tell process "ChatGPT" to set size of front window to {1600, 900}'
   ```

   For another app, list its windows first (names, then sizes) and pick the big one:
   `osascript -e 'tell application "System Events" to tell process "<App>" to get {name, size} of every window'`.

   ⇧⌘5 → **Record Selected Portion** works too, with no install: drag the box around the
   window, **no microphone**, stop from the menu bar (or ⌃⌘Esc). You get a `.mov` on the
   Desktop. It can't follow a single window, and the stop button hides behind the notch.

2. Optional: speed up the waiting. A demo that sits on a spinner can play that stretch fast
   instead of cutting it, so the audience still sees it happen. With ffmpeg
   (`brew install ffmpeg`), this plays 19–54s at 8× and the whole result at 2×:

   ```sh
   ffmpeg -i ~/Movies/"2026-10-13 14-48-53.mp4" -filter_complex \
     "[0:v]trim=0:19,setpts=PTS-STARTPTS[a]; \
      [0:v]trim=19:54,setpts=(PTS-STARTPTS)/8[b]; \
      [0:v]trim=54,setpts=PTS-STARTPTS[c]; \
      [a][b][c]concat=n=3:v=1:a=0,setpts=PTS/2,fps=30[v]" \
     -map "[v]" -an -c:v libx264 -crf 18 -pix_fmt yuv420p ~/Movies/chatgpt-fast.mp4
   ```

   The cut points are in the original recording's time. Drop `,setpts=PTS/2` to keep the
   rest at normal speed. `fps=30` drops the surplus frames, which would otherwise claim
   hundreds of FPS in the fast stretch. Watch the result once: the prompt and the answer
   must stay readable from the back of the room. For a plain cut with no install, use
   QuickTime: **Edit → Split Clip** (⌘Y) at both ends, then delete the middle clip.

3. Encode it, from a normal terminal (not Claude's sandbox). Any `.mov` or `.mp4` works:

   ```sh
   npm run video:add -- ~/Movies/chatgpt-fast.mp4 chatgpt-desktop
   ```

   This writes `media/videos/chatgpt-desktop.mp4` (H.264, at most 1920×1080, no audio) and
   a `.jpg` poster, replacing any earlier ones, and prints the size. OBS records an audio
   track by default: with ffmpeg installed, the script drops it (no re-encode), and
   without, it warns. Keep the original recording too, in case you want to re-cut it.

4. Check it on the slide with ⇧⌥V. `offline:check` then counts it as present.

`media/videos/` is gitignored: back up the recordings yourself. The demo ids are in
`deck/demos.js`. A new one also needs `demo="<id>"` on its `DemoSlide` in `index.html`.

## What still needs a network

- Anything that calls a cloud LLM (for example, Claude Desktop over the WebMCP relay). Use the
  [backup video](#when-a-live-demo-fails).
- The demo sites: they load from `nearform.github.io`, and their CDN files and models aren't in
  `offline/`. See [handoffs/offline-handoff.md](handoffs/offline-handoff.md) §3, phase 5.

## Command reference

| Command                    | When                    | What it does                                                 |
| -------------------------- | ----------------------- | ------------------------------------------------------------ |
| `npm run dev`              | always                  | Serves the deck on :3000                                     |
| `npm run cdp:talk`         | always                  | The talk Chrome, persistent profile, CDP on :1981            |
| `npm run talk:open`        | talk day                | Deck with `?offline` plus a tab per demo, in the talk Chrome |
| `npm run demo:relay`       | talk day, online        | WebMCP relay on :9333 for Claude Desktop                     |
| `npm run demo:relay:ps`    | relay trouble           | What's on :9333                                              |
| `npm run demo:relay:stop`  | relay trouble           | Stops the relay listening on :9333                           |
| `npm run offline:fetch`    | prep, after dep changes | Saves every CDN file, font and image to `offline/`           |
| `npm run offline:model`    | prep                    | Downloads Gemma to `offline/models/`                         |
| `npm run offline:check`    | prep                    | Walks the deck with external hosts blocked; must print PASS  |
| `npm run video:add`        | after recording a demo  | Encodes a backup recording into `media/videos/`              |
| `npm run cdp` / `cdp:stop` | tests only              | Throwaway Chrome on :1980; `cdp:stop` deletes its profile    |
