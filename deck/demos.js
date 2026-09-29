/**
 * Backup recordings for the live demos, keyed by demo id.
 *
 * A demo slide opts in with `demo="<id>"` on `DemoSlide`, which becomes the
 * Spectacle slide's `id`. The video button in the deck chrome reads that id from
 * `SlideContext` and shows only when it is listed here.
 *
 * PLAIN DATA, NO IMPORTS: `npm run video:add` and `npm run offline:check` import
 * this file from Node to check an id and to find missing recordings.
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
