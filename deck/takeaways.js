/**
 * Takeaway identity: the single source of truth for the talk's six claims.
 *
 * Deliberately shaped like `chapters.js`, and for the same reason. Each takeaway
 * appears THREE times in the deck -- on the roadmap slide up front, as its own
 * chapter's closing beat, and in the recap at the end -- which is exactly the
 * arrangement where three hand-typed copies drift apart and nobody notices until
 * a projector is involved. Edit the claim here and all three move together.
 *
 * The talk is built so every slide lands one of these; a slide that lands none
 * is a slide to cut.
 */

/**
 * The verdict marks: an icon, and nothing else.
 *
 * These carried "Paved road / Rough trail / Past the map" labels for a while. The
 * labels were the whole reason road-horizon, path and compass made sense -- and
 * they were not pulling their weight on the slide, so both went.
 *
 * Icon-only means the glyph has to read on its own, with no caption and from the
 * back of a room, so these are the boring universal ones rather than the
 * evocative ones:
 *
 *   ready       check-circle   this works, go use it
 *   constrained warning        works, with limits
 *   early       flask          experiment, not a foundation
 *
 * They take `--chapter-accent` instead of a color of their own. Nearform's palette
 * has no amber, and inventing one for a single warning icon would put a hue in the
 * deck the brand does not have. The confidence progression is already carried by
 * the chapter accents (green -> darkGreen -> purple, see `chapters.js`).
 */
export const VERDICTS = {
  ready: { icon: "check-circle", title: "Ready to use" },
  constrained: { icon: "warning", title: "Works, with limits" },
  early: { icon: "flask", title: "Early / experimental" },
};

/**
 * The two halves of the talk -- which are the two halves of its title.
 *
 * "WebMCP and The Agent-Ready Browser" is already a pair joined by "and", so the
 * 3/3 split of the takeaways maps straight onto it and the roadmap slide reads as
 * the accepted title expanded into six claims.
 *
 * Earlier drafts named these as transformations ("your app becomes callable" /
 * "the browser becomes the runtime"). Accurate, but abstract, and they sat at a
 * different altitude from the plain-noun chapter dividers.
 */
export const PARTS = {
  A: { key: "A", title: "WebMCP", icon: "plugs-connected" },
  B: { key: "B", title: "The agent-ready browser", icon: "browser" },
};

/**
 * The six.
 *
 * `text` and `detail` render as plain text, NOT markdown -- they go straight into
 * a Spectacle `Text`. Markdown here shows up literally, asterisks and all.
 *
 *   text    -- the claim, short enough to be a tile on the roadmap slide
 *   detail  -- the evidence or the caveat; dropped on dense slides
 *   chapter -- where this one is earned, and therefore which accent it takes
 *   verdict -- a key into VERDICTS, for the three that are assessments rather
 *              than instructions
 */
export const takeaways = [
  {
    n: 1,
    part: "A",
    chapter: 1,
    text: "You can add WebMCP today",
    detail: "Declarative or functional. It's a function you already have.",
  },
  {
    n: 2,
    part: "A",
    chapter: 1,
    text: "Agent-enable the apps you already have",
    detail: "TODO: DETAIL",
  },
  {
    n: 3,
    part: "A",
    chapter: 1,
    text: "TODO: REMOVE",
    detail: "TODO: REMOVE",
  },
  {
    n: 4,
    part: "B",
    chapter: 2,
    verdict: "ready",
    text: "Vector search in the browser works really well",
    detail: "Fast, private, no backend required.",
  },
  {
    n: 5,
    part: "B",
    chapter: 3,
    verdict: "constrained",
    text: "On-device models: powerful but constrained",
    detail: "Starting to become usable.",
  },
  {
    n: 6,
    part: "B",
    chapter: 4,
    verdict: "early",
    text: "A full agent workflow runs in a browser tab",
    detail: "Can even get full agents going.",
  },
];

/**
 * The two halves of the room, and what each should leave repeating.
 *
 * This is where the six roll up. The talk is aimed at two audiences sitting in
 * the same room -- people who build AI systems and never think about the
 * frontend, and people who build frontends and never think about agents -- and
 * each gets exactly one instruction.
 *
 * `rollUp` names the takeaways that earn each instruction, so the closing slide
 * can be checked against the evidence rather than asserted.
 *
 * ORDER MATTERS: frontends first, because their takeaways (1-3, Part A / WebMCP)
 * come first in the talk. Both the cold-open seed slide and the closing payoff
 * render this array as-is, so the cards always follow the running order.
 */
export const AUDIENCES = [
  {
    key: "frontend",
    icon: "browser",
    who: "If you build frontends",
    claim: "Agents are increasing users of your browser apps.",
    action: "Register a few tools and see what happens.",
    rollUp: [1, 2, 3],
  },
  {
    key: "ai",
    icon: "brain",
    who: "If you build AI systems",
    claim: "Agents (or parts) can run in your browser apps.",
    action: "Ask which parts of your stack could move to the browser.",
    rollUp: [4, 5, 6],
  },
];

/** One takeaway by its number, for `takeaway(4)` lookups in the deck. */
export const takeaway = (n) => takeaways.find((t) => t.n === n);

/** Every takeaway in one half of the talk, e.g. `byPart("A")`. */
export const byPart = (part) => takeaways.filter((t) => t.part === part);

/**
 * Every takeaway a chapter is responsible for.
 *
 * This is what the chapter-closing slides are built from, so a takeaway cannot
 * be defined here and then quietly never land on a slide.
 */
export const byChapter = (n) => takeaways.filter((t) => t.chapter === n);
