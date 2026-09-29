# Offline mode

Present the talk with no network. Works on `localhost` only; the published site is unaffected.
Implementation notes: [handoffs/offline-handoff.md](handoffs/offline-handoff.md).

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

Then open **<http://localhost:3000/?offline>** once, while still online, so the service worker
installs.

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

1. Turn wifi **off**.
2. Run `npm run dev` and `npm run cdp:talk`.
3. Open **<http://localhost:3000/?offline>**. If the deck is blank, reload once.
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
shows "No recording yet" instead.

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

- Anything that calls a cloud LLM (for example, a desktop agent over the WebMCP relay). Use the
  [backup video](#when-a-live-demo-fails).
- External demo sites, unless they're served locally. See
  [handoffs/offline-handoff.md](handoffs/offline-handoff.md) §3, phase 5.
