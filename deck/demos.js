/**
 * The live demos, keyed by demo id.
 *
 * A demo slide opts in with `demo="<id>"` on `DemoSlide`, which becomes the
 * Spectacle slide's `id`.
 *
 * PLAIN DATA, NO IMPORTS: `npm run video:add`, `npm run offline:check` and
 * `npm run talk:open` import this file from Node.
 */

/**
 * The page each demo runs on, in talk order. `DemoSlide` links to it with an
 * open-in-new-tab icon, and `npm run talk:open` opens every one as a tab.
 *
 * Both vector-search-web demos share one tab: `?present=true` trims it down for
 * the projector (a generic title), and it is the tab Claude Desktop connects to.
 *
 * `?relay=false` on the others keeps them off the WebMCP relay. Every open tab
 * that bridges registers its tools with it, so with more than one open Claude
 * Desktop would see each search tool more than once, under suffixed names.
 */
export const DEMO_LINKS = {
  "chatgpt-desktop": "https://www.reebok.com/",
  "claude-desktop":
    "https://nearform.github.io/vector-search-web/?present=true",
  "vector-search": "https://nearform.github.io/vector-search-web/?present=true",
  "web-ai":
    "https://nearform.github.io/web-ai-demo/?runtime=wllama&model=ggml-org%2Fgemma-4-E2B-it-GGUF%7Cgemma-4-E2B-it-Q4_0.gguf",
  "web-agents": "https://nearform.github.io/web-agents/?relay=false",
};

/**
 * The pieces each demo uses, by id from `PIECES` in `pieces.js`.
 *
 * A demo listed here gets the piece strip on its slide, and every piece named
 * here gets the play icon on "The available pieces". The Claude Desktop demo is
 * left out because it comes before that slide.
 */
export const DEMO_PIECES = {
  "vector-search": ["embeddings", "vector-db"],
  "web-ai": ["tools", "language-models"],
  "web-agents": ["embeddings", "vector-db", "tools", "language-models"],
};

/**
 * The cell of "Who calls, and from where?" each WebMCP demo lands in, in talk
 * order. A cell id is `<agent>-<site>`: `native` or `mcp` (how the agent speaks
 * to the page), `agent` or `tab` (whose browser the page is open in).
 *
 * A demo listed here gets the grid in place of its bullet points, with its own
 * cell lit and any earlier demo's cell marked as visited.
 */
export const DEMO_CALLS = {
  "chatgpt-desktop": "native-agent",
  "claude-desktop": "mcp-tab",
};

/**
 * Backup recordings for the live demos.
 *
 * The video button in the deck chrome reads the slide id and shows only when it
 * is listed here.
 *
 * The files live in `media/videos/`, which is gitignored. A listed id whose file
 * is missing still gets its button; the overlay then says which file to add. See
 * docs/offline.md, "Backup recordings".
 */
export const DEMO_VIDEOS = {
  "chatgpt-desktop": "ChatGPT shops reebok.com with its site tools",
  "claude-desktop": "Claude Desktop calls our page over the relay",
  "vector-search": "Vector search",
  "web-ai": "Web AI demos",
  "web-agents": "Nearform research agents",
};

export const VIDEO_DIR = "media/videos";

/** Paths relative to the repo root, which is also the site root. */
export const videoPath = (id) => `${VIDEO_DIR}/${id}.mp4`;
export const posterPath = (id) => `${VIDEO_DIR}/${id}.jpg`;
