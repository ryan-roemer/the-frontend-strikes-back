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

`offline:check` must print **PASS** with `missed URLs: 0`. Re-run `offline:fetch` after any
dependency change.

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

Still failing after `offline:fetch`? A missed URL that `offline:fetch` doesn't save is a bug in
the recorder: note the URL and see the handoff.

## The `?offline` flag

| URL              | Effect                                                           |
| ---------------- | ---------------------------------------------------------------- |
| `?offline`       | Installs the service worker and serves CDN files from `offline/` |
| no flag          | Loads from the network as usual, even if the worker is installed |
| `?offline=false` | Uninstalls the worker                                            |

`=true` and `=1` also turn it on. Slide changes keep the flag. Switching Spectacle modes
(presenter, overview, print) can drop it, so check the URL after you do.

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

## What still needs a network

- Anything that calls a cloud LLM (for example, a desktop agent over the WebMCP relay). Use the
  backup video.
- External demo sites, unless they're served locally. See
  [handoffs/offline-handoff.md](handoffs/offline-handoff.md) §3, phase 5.
