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
 * The two vector-search-web links are the same app: `?present=true` trims it down for the
 * projector (a generic title), which is what the Claude Desktop demo wants.
 *
 * `?relay=false` on the others keeps them off the WebMCP relay. Every open tab
 * that bridges registers its tools with it, so with all of them open Claude
 * Desktop would see each search tool more than once, under suffixed names.
 */
export const DEMO_LINKS = {
  "chatgpt-desktop": "https://www.reebok.com/",
  "claude-desktop":
    "https://nearform.github.io/vector-search-web/?present=true",
  "vector-search": "https://nearform.github.io/vector-search-web/?relay=false",
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
  "web-agents": [
    "embeddings",
    "vector-db",
    "deciders",
    "tools",
    "language-models",
  ],
};

/**
 * Backup recordings for the live demos.
 *
 * The video button in the deck chrome reads the slide id and shows only when it
 * is listed here.
 *
 * The files live in `media/videos/`, which is gitignored. A listed id whose file
 * is missing still gets its button; the overlay then says which file to add. See
 * docs/offline.md, "When a live demo fails".
 */
export const DEMO_VIDEOS = {
  "chatgpt-desktop": "ChatGPT shops reebok.com with its site tools",
  "claude-desktop": "Claude Desktop calls our page over the relay",
  "deck-tools": "This deck has WebMCP tools",
  "vector-search": "Vector search",
  "web-ai": "Web AI demos",
  "web-agents": "Nearform research agents",
};

export const VIDEO_DIR = "media/videos";

/** Paths relative to the repo root, which is also the site root. */
export const videoPath = (id) => `${VIDEO_DIR}/${id}.mp4`;
export const posterPath = (id) => `${VIDEO_DIR}/${id}.jpg`;
