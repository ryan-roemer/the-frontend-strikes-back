# Offline mode

Present the talk with no network. Works on `localhost` only; the published site is unaffected.

> **Status: planned.** The commands below don't exist yet. Implementation notes are in
> [handoffs/offline-handoff.md](handoffs/offline-handoff.md).

## Before the trip (on good wifi)

```sh
npm install              # pins the dev server and the relay locally
npm run dev              # serve the deck on :3000
npm run cdp:talk         # Chrome with the persistent talk profile
npm run offline:fetch    # record and save every CDN file, font and image
npm run offline:model    # download Gemma (2 GB) to offline/models/
npm run offline:check    # load the whole deck with external hosts blocked
```

In the talk profile, also:

- Open the assistant and switch to **Chrome**. Wait for Gemini Nano to finish downloading
  (check `chrome://on-device-internals`).
- Ask one question on **each** provider.

`offline:check` must pass with zero missed URLs. Re-run `offline:fetch` after any
dependency change.

## At the venue

1. Turn wifi **off**.
2. Run `npm run dev` and `npm run cdp:talk`.
3. Walk the deck once. The assistant's status should read "on disk".

`npm run cdp:stop` wipes only the throwaway `cdp` profile. The talk profile, with its cached
models, survives it.

## When a live demo fails

On a slide that has a backup video, a video button appears next to the tools and chat
buttons. Click it or press the hotkey to play the recording, and press Esc to go back.

Videos are in `media/videos/`.

## What still needs a network

- Anything that calls a cloud LLM (for example, a desktop agent over the WebMCP relay). Use
  the backup video.
- External demo sites, unless they're served locally. See
  [handoffs/offline-handoff.md](handoffs/offline-handoff.md) §3, phase 5.
