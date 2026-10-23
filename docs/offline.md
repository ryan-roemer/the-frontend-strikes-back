# Offline mode

Present the deck with no network. Works on `localhost` only; the published site is unaffected.

The deck runs fully offline. The live demos load from their live sites, and the Claude Desktop
demo calls a cloud model, so those need a network or a [backup recording](#backup-recordings).

## Prepare (online)

```sh
npm install
npm run dev              # serve the deck on :3000
npm run cdp:talk         # Chrome with a persistent talk profile, CDP on :1981
npm run offline:fetch    # save every CDN file, font and image to offline/
npm run offline:model    # download Gemma (2 GB) to offline/models/
npm run offline:check    # walk the deck with external hosts blocked; must print PASS
```

- `offline:fetch -- --force` downloads everything again. Re-run `offline:fetch` after any
  dependency change.
- `offline:model` resumes an interrupted download.
- `offline:check -- --no-gemma` / `-- --no-nano` skip a model; `-- --shots` saves a screenshot
  per slide to `offline/verify/`.

## Present

```sh
npm run dev          # serve the deck on :3000
npm run demo:relay   # WebMCP relay on :9333, for Claude Desktop (online only)
npm run cdp:talk     # the deck with ?offline in an app window
npm run talk:open    # the demos in a second window, deck to the front
npm run talk:ready   # reset the demo tabs between run-throughs
```

Start `demo:relay` before `talk:open`: the Claude Desktop tab looks for the relay once, when it
loads.

## The `?offline` flag

| URL              | Effect                                                           |
| ---------------- | ---------------------------------------------------------------- |
| `?offline`       | Installs the service worker and serves CDN files from `offline/` |
| no flag          | Loads from the network as usual, even if the worker is installed |
| `?offline=false` | Uninstalls the worker                                            |

## The relay (Claude Desktop demo)

Claude Desktop reaches the page through `@mcp-b/webmcp-local-relay`, which the page connects to
over a WebSocket on `127.0.0.1:9333`. In Claude Desktop, Settings → Developer → Edit Config:

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

Full paths, because Claude Desktop doesn't load nvm. Quit and reopen Claude Desktop after
editing it.

```sh
npm run demo:relay        # run the relay in the foreground on :9333
npm run demo:relay:ps     # list every process with a socket on :9333
npm run demo:relay:stop   # stop a stuck relay listening on :9333
```

## Backup recordings

Every demo slide has a recording slot in `DEMO_VIDEOS` (`deck/demos.js`). On `localhost`, ⇧⌥V
plays it fullscreen (Space pauses, ←/→ seek 5 seconds, Esc closes).

```sh
npm run video:add -- <recording.mp4|.mov> <demo-id>
```

This writes `media/videos/<demo-id>.mp4` (H.264, at most 1920×1080, no audio) and a `.jpg`
poster. `media/videos/` is gitignored.

## Command reference

| Command                    | What it does                                                    |
| -------------------------- | --------------------------------------------------------------- |
| `npm run dev`              | Serves the deck on :3000                                        |
| `npm run cdp:talk`         | The talk Chrome, persistent profile, CDP on :1981               |
| `npm run talk:open`        | Deck with `?offline` in an app window, demos in a second window |
| `npm run talk:ready`       | Readies the demo tabs between run-throughs                      |
| `npm run demo:relay`       | WebMCP relay on :9333 for Claude Desktop                        |
| `npm run demo:relay:ps`    | What's on :9333                                                 |
| `npm run demo:relay:stop`  | Stops the relay listening on :9333                              |
| `npm run offline:fetch`    | Saves every CDN file, font and image to `offline/`              |
| `npm run offline:model`    | Downloads Gemma to `offline/models/`                            |
| `npm run offline:check`    | Walks the deck with external hosts blocked; must print PASS     |
| `npm run video:add`        | Encodes a backup recording into `media/videos/`                 |
| `npm run cdp` / `cdp:stop` | Throwaway Chrome on :1980 for `npm test`; `cdp:stop` deletes it |
