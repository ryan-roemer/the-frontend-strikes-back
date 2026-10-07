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

| Slide (chapter)               | Demo id          | Opens                                                |
| ----------------------------- | ---------------- | ---------------------------------------------------- |
| Claude Desktop calls our page | `claude-desktop` | `nearform.github.io/vector-search-web/?present=true` |
| Vector search (2)             | `vector-search`  | `nearform.github.io/vector-search-web/?relay=false`  |
| Web AI demos (2)              | `web-ai`         | `nearform.github.io/web-ai-demo/`                    |
| Nearform research agents (3)  | `web-agents`     | `nearform.github.io/web-agents/?relay=false`         |

- **On the slide:** the ↗ icon after the URL opens the demo in a new tab. It's there on the
  published deck too.
- **All at once:** `npm run talk:open` opens the deck and all four, in this order, then brings
  the deck tab to the front. It skips tabs already open at the same URL. It **closes** any deck
  tab without `?offline` (the one `cdp:talk` opens), because that tab is blank with no network.
- `?present=true` gives vector-search-web a generic title for the projector.
- `?relay=false` keeps a tab off the relay. Every tab that connects adds its tools to Claude
  Desktop's list, so with both vector-search-web tabs connected Claude sees each tool twice, under
  suffixed names (`search_ed93`, `search_a1b2`). Only the Claude Desktop tab should connect.

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
npm run offline:check    # walk the deck and ask Gemma, with external hosts blocked
```

`offline:check` must print **PASS** with `missed URLs: 0` and `missing: 0` backup videos.
Re-run `offline:fetch` after any dependency change.

- `offline:fetch` reuses files it already has; `npm run offline:fetch -- --force` downloads
  everything again. It fails, and lists the URLs, if any file couldn't be saved.
- `offline:model` resumes where it stopped, so if it fails, run it again. It skips the
  download if the file is already complete.
- `offline:check` options: `-- --no-gemma` skips the model, `-- --shots` saves a screenshot
  per slide to `offline/verify/`.

In the talk profile, also:

- Open the assistant and switch to **Chrome**. Wait for Gemini Nano to finish downloading
  (check `chrome://on-device-internals`).
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

Recordings: `claude-desktop` (the relay demo) and `web-agents`. A demo without its file
shows "No recording yet" instead. `vector-search` and `web-ai` have no recording slot yet:
add them to `DEMO_VIDEOS` in `deck/demos.js` to get the button.

## Add a recording

1. Record the demo with ⇧⌘5 → **Record Selected Portion** (or the whole screen), **no
   microphone**. Stop from the menu bar. You get a `.mov` on the Desktop.
2. Encode it, from a normal terminal (not Claude's sandbox):

   ```sh
   npm run video:add -- ~/Desktop/"Screen Recording ….mov" web-agents
   ```

   This writes `media/videos/web-agents.mp4` (H.264, at most 1920×1080, no audio) and a
   `.jpg` poster, replacing any earlier ones, and prints the size.

3. Check it on the slide with ⇧⌥V. `offline:check` then counts it as present.

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
