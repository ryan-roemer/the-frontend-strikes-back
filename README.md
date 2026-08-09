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

| Parameter             | Effect                                                       |
| --------------------- | ------------------------------------------------------------ |
| `?animate=false`      | Disable `Appear` step animations (reveal everything at once) |
| `?presenterMode=true` | Presenter view with speaker notes                            |
| `?slideIndex=N`       | Jump directly to a slide                                     |
