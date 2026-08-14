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
| `?dump`               | Show the whole deck as one Markdown document (see below)      |

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

### The deck as Markdown

[`chat/harvest/`](chat/harvest/) reads the running deck — every heading, bullet, code block and
speaker note — and emits it as one Markdown document. `?dump` shows it over the deck; in the
console, `window.deckDump` offers `.markdown()`, `.slides()` and `.log()`.

It reads React's fiber tree rather than the DOM, which is what makes structure survive: Spectacle
renders `Heading` and `Text` both as `styled.div`, so a rendered slide has no headings to find,
no lists to nest, and code panes only as Prism spans. The fiber tree has the components, the code
panes' original source, the markdown slides' original markdown, and the speaker notes — which are
in no DOM at all, because `Notes` renders `null` outside presenter mode.

Speaker notes are fenced in `<speaker-notes>` tags so a consumer can drop them wholesale; they
carry TODOs and presenter-private asides.

### Addressing what is on a slide

The document above is readable but not _pointable_. Every text run on every slide also gets a short
global id — `9.2` is the second addressable node on slide 9 — with the role a presenter would use
for it, a pointer at the source that produced it, and a handle on the live element:

```js
deckDump.nodes(); // all 162, addressed
deckDump.node("9.2"); // + the live DOM element
await deckDump.where("9.2"); // + where it came from. JSON-safe, for pasting
```

`where()` is honest about how well it knows. 39 nodes trace exactly to a field in `deck/takeaways.js`
or `deck/chapters.js`; 66 more appear verbatim exactly once in `index.html`; 17 are only findable as
a fragment, because `em()` and `<br />` split a rendered line across several literals. Seven are
composed at runtime and exist as a string nowhere — for those it says so and returns no search key,
because a wrong pointer costs more than an absent one.

You can also just say what you mean, and read it back before changing anything:

```js
deckDump.locate("the second bullet"); // -> node 9.3
deckDump.locate("the WebMCP one"); // matched on content, not position
deckDump.describe("9.3"); // 'slide 9, bullet 2 — "One API: document.modelContext"'
```

`locate()` tries content before position, because "the WebMCP one" either matches exactly one node or
none, while "the second bullet" is never _absent_ — only possibly the wrong one. When several nodes
match it returns all of them rather than guessing; slide 31 says "TODO" three times, so that case is
real. Sub-bullets are counted within their own list, so "the fourth bullet" on slide 9 is the fourth
bullet a presenter sees and not the first nested one.

There are also **sized views**, because context is the scarce resource on a 2B model with an 8k
window. `deckDump.context(question)` runs the same rule a turn would and shows you the cost:

```
   46 ch  [position]         "go to the last slide"
  257 ch  [position+slide]   "summarize this slide"
 1079 ch  [position+outline] "which slide covers WebMCP?"
 7258 ch  [position+index]   "find every TODO in the whole deck"
```

Navigation needs no slide content at all, which is why the default is ~80 tokens rather than the
~750 a whole-deck summary would cost. The view is chosen in JavaScript, never by the model.

Nothing here is wired into the assistant's prompt yet — `chat/agent/prompt.js` is still the seam,
and this is the other half of it. The design, the measurements and the next steps are in
[docs/deck-context-handoff.md](docs/deck-context-handoff.md).
