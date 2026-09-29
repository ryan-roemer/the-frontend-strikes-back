---
name: offline-prep
description: Get the deck ready to present with no network — runs offline:fetch, offline:model and offline:check in order, then explains every missed URL and what fixes it. Use when the user says "offline prep", "get ready for the talk", "prep for no wifi", or pastes offline:check output that failed.
---

# Offline prep

A thin wrapper. The logic lives in the scripts; this skill runs them in order and reads the
report. Presenter doc: `docs/offline.md`. Build notes: `docs/handoffs/offline-handoff.md`.
Don't re-implement a check here. If a script is wrong, fix the script.

## 0. What the user has to start

Chrome can't be launched from inside Claude's sandbox (`open` is blocked, and the binary
aborts with "Failed to create socket directory"). Ask the user to run these and leave them
open:

```sh
npm run dev          # :3000
npm run cdp:talk     # the persistent talk profile, CDP on :1981
```

The offline scripts default to :1981. A throwaway `cdp` Chrome on :1980 doesn't get in the
way. Never suggest `cdp:stop` to fix a talk-profile problem: it deletes the throwaway profile
and doesn't touch the talk Chrome.

## 1. Run the three steps, in order

Stop at the first one that fails, and explain it before going on.

```sh
NODE_USE_ENV_PROXY=1 npm run offline:fetch   # CDN files, fonts, images, LiteRT wasm
npm run offline:model                         # Gemma, 2 GB, resumable
npm run offline:check                         # walk + Gemma answer, external hosts blocked
```

`NODE_USE_ENV_PROXY=1` because Node's `fetch` ignores `HTTPS_PROXY` inside the sandbox.

If a step can't reach the Chrome on :1981 from the sandbox, don't work around it. Ask the user
to run that command themselves and paste the whole output.

## 2. Read the report

`offline:check` passes only with `PASS` and `missed URLs: 0`. Each missed URL line is
`<reason>, <in offline/ | not in offline/>  <page|sw>  <url>`. Go through **every** line:

| Line                                  | Cause and fix                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not in offline/`, CDN host           | Not recorded. Re-run `offline:fetch`. If it's still missing afterwards, the recorder doesn't reach it: find which slide or module loads it and say why (lazy import, preload, a CSS `url(…)`), then fix `scripts/offline-fetch.mjs`.                               |
| `not in offline/`, `.litertlm`        | Model not downloaded, or the file name in `chat/agent/providers/litert.js` changed. Re-run `offline:model`.                                                                                                                                                        |
| `in offline/`, `blocked`              | Saved, but the worker didn't answer. Usually the page lost `?offline` or the worker isn't in control yet: reload `/?offline` once. If it keeps happening for one URL, compare its exact URL with the manifest key (query string, trailing slash) and read `sw.js`. |
| `in offline/`, `net::…` (not blocked) | The worker answered and the load still failed: wrong `content-type`, or a truncated file. Check that URL's entry in `offline/manifest.json` against the file size.                                                                                                 |
| `sw` label                            | The request came from the worker's own fetch, which means it passed the URL through: same causes as the `blocked` rows.                                                                                                                                            |
| `service worker not in control`       | First `?offline` load on the profile. Reload once. Otherwise `/?offline=false`, then `/?offline`.                                                                                                                                                                  |
| Gemma `error` or `timed out`          | No GPU, or the model file is missing. `-- --no-gemma` gets the rest of the report.                                                                                                                                                                                 |
| `no CDP at …:1981`                    | The talk Chrome isn't running, or was started before it moved off :1980 (it still listens there). Ask the user to quit it and run `npm run cdp:talk`.                                                                                                              |
| `backup videos: … missing: N`         | A demo in `deck/demos.js` has no `media/videos/<id>.mp4` (gitignored, so a fresh clone has none). Not a URL problem. The user records it and runs `npm run video:add -- <file.mov> <id>` from a normal terminal: see `docs/offline.md`, "Add a recording".         |
| console errors                        | Not a URL, but still a failure. `deck/code-editor.js`'s sourcemap-codec error is known and unrelated (handoff, phase 1).                                                                                                                                           |

`NOTE: the model was already cached` is not a failure. It means the check didn't exercise
`offline/models/`. Say so, and only suggest a wiped profile if the user wants that tested.

## 3. Report back

One line per step (passed, or what failed), then each miss with its cause and the fix you
applied or recommend. Finish with the manual steps `docs/offline.md` lists that no script
covers: Gemini Nano downloaded in the talk profile, one question per provider, and one
`/?offline` load while still online.
