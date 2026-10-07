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
 * The first two are the same app: `?present=true` trims it down for the
 * projector (a generic title), which is what the Claude Desktop demo wants.
 *
 * `?relay=false` on the others keeps them off the WebMCP relay. Every open tab
 * that bridges registers its tools with it, so with all of them open Claude
 * Desktop would see each search tool more than once, under suffixed names.
 */
export const DEMO_LINKS = {
  "claude-desktop":
    "https://nearform.github.io/vector-search-web/?present=true",
  "vector-search": "https://nearform.github.io/vector-search-web/?relay=false",
  "web-ai": "https://nearform.github.io/web-ai-demo/",
  "web-agents": "https://nearform.github.io/web-agents/?relay=false",
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
  "claude-desktop": "Claude Desktop calls our page over the relay",
  "web-agents": "Nearform research agents",
};

export const VIDEO_DIR = "media/videos";

/** Paths relative to the repo root, which is also the site root. */
export const videoPath = (id) => `${VIDEO_DIR}/${id}.mp4`;
export const posterPath = (id) => `${VIDEO_DIR}/${id}.jpg`;
