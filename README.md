# The Frontend Strikes Back

## Talk

[AgntCon + MCPCon North America talk](https://events.linuxfoundation.org/agntcon-mcpcon-north-america/program/schedule/?id=1230048)

**The Frontend Strikes Back: WebMCP and The Agent-Ready Browser**

AI agents already use your web app. They're just doing it poorly: screen-scraping, driving Playwright MCP through human-shaped UIs, and working around frontends never built for them.

WebMCP changes the contract. A new rising W3C standard, it brings MCP into the frontend: apps register structured, discoverable tools that agents call, reusing your existing auth, personalization, and business logic. Going agent-ready this way can be much faster than traditional MCP servers.

This talk starts with the basics: registering tools, defining schemas, and making frontend functions agent-callable. We'll use Claude Desktop to drive a frontend-only document-retrieval app via WebMCP.

Then, we'll push the frontend even further with a research assistant running fully in-browser, featuring multi-agent coordination, semantic search, multiple WebMCP tools, and on-device models. Navigating some stumbling blocks and hacks, we'll tour the impressive world of web-based AI and agents.

You'll walk away with an introduction to the frontend-for-agents landscape and concrete next steps to prototype against WebMCP and start building today for the AI agents arriving tomorrow.

## Development

This deck is built with [Spectacle](https://nearform.com/open-source/spectacle) and has **no build step** — native ES modules, an import map, and [htm](https://github.com/developit/htm) template literals.

```sh
$ npm run dev      # serve the deck locally
$ npm run format   # eslint --fix + prettier --write
```

Dependencies are pinned and version-deduped entirely through the import map in `index.html`.
Before changing any version, read [docs/dependencies.md](docs/dependencies.md) — it covers how
the remaps and scopes work, which upgrades are deliberately blocked, and how to verify a change.

### Deck URL parameters

| Parameter             | Effect                                                        |
| --------------------- | ------------------------------------------------------------- |
| `?animate=false`      | Disable `Appear` step animations and slide transitions        |
| `?presenterMode=true` | Presenter view with speaker notes                             |
| `?slideIndex=N`       | Jump directly to a slide                                      |
| `?exportMode=true`    | All slides stacked, deck styling intact — print this to PDF   |
| `?printMode=true`     | All slides stacked, light ink-saving theme for paper handouts |
| `?chat`               | Open the deck assistant on load (see below)                   |

Transitions are also disabled automatically under `prefers-reduced-motion`.

## Deck assistant

The robot button in the deck chrome opens a chat panel backed by a model running **entirely on
your machine**. It is self-contained in [`chat/`](chat/) and mounted dynamically, so the deck
works with it removed.

Two providers, switchable live from the panel header:

| Provider   | Runtime                                                                       | Model                                         | Needs                       |
| ---------- | ----------------------------------------------------------------------------- | --------------------------------------------- | --------------------------- |
| **Gemma**  | [LiteRT-LM](https://developers.google.com/edge/litert-lm/js)                  | Gemma 4 E2B — a 2 GB download the page owns   | WebGPU, any desktop browser |
| **Chrome** | [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) `LanguageModel` | Gemini Nano — Chrome's, invisible to the page | Chrome only                 |

The panel is closed by default and deliberately does not remember being open, so a normal deck
load touches no model at all. `?chat` opens it. Nothing is sent anywhere.

The Chrome pill only appears when the browser exposes `LanguageModel`; the Gemma pill is always
offered and explains itself when WebGPU is unavailable.

> **Before presenting:** fetch the Gemma model on a connection you trust and ask one question on
> each provider. See the pre-flight in [docs/chat-handoff.md](docs/chat-handoff.md), which is also
> the record of what each provider can and cannot do, and the measured numbers behind those
> choices.
