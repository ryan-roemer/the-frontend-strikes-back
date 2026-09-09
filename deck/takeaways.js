/**
 * Takeaway identity: the single source of truth for the talk's three verdicts.
 *
 * Deliberately shaped like `chapters.js`, and for the same reason.
 *
 * This used to be six claims, each rendered three times -- on a roadmap slide up
 * front, at its chapter's close, and again in a recap at the end. In a 25-minute
 * slot that arrangement spent about four slides restating things nobody had
 * forgotten, so the roadmap and the recap are gone. What is left is one verdict
 * per chapter, shown once, where the chapter has just earned it.
 *
 * The file name and the `takeaways` export stay as they are. `verdicts` reads
 * better now, but the name is referenced from `chat/agent/prompt.js`,
 * `chat/harvest/` and the provenance pointers, and this was a content revision
 * rather than a rename.
 *
 * The talk is built so every chapter lands one of these; a chapter that lands
 * none is a chapter to cut.
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
 * the chapter accents (darkGreen -> purple, see `chapters.js`; chapter 1 sits
 * outside that gradient in blue, and takes `ready` on its own).
 */
export const VERDICTS = {
  ready: { icon: "check-circle", title: "Ready to use" },
  constrained: { icon: "warning", title: "Works, with limits" },
  early: { icon: "flask", title: "Early / experimental" },
};

/**
 * The three.
 *
 * `text` and `detail` render as plain text, NOT markdown -- they go straight into
 * a Spectacle `Text`. Markdown here shows up literally, asterisks and all.
 *
 *   text    -- the verdict, short enough to read from the back of the room
 *   detail  -- the evidence or the caveat that keeps the verdict honest
 *   chapter -- where this one is earned, and therefore which accent it takes
 *   verdict -- a key into VERDICTS
 *
 * Every one of them now carries a `verdict`, which the six did not. That is the
 * point of the shape: each chapter ends by saying how far along its subject
 * actually is, and the three answers are different.
 */
export const takeaways = [
  {
    n: 1,
    chapter: 1,
    verdict: "ready",
    text: "WebMCP is ready",
    detail: "If you ship a web app, you can be agent-ready in an afternoon.",
  },
  {
    n: 2,
    chapter: 2,
    verdict: "constrained",
    text: "In-browser AI is real, but constrained",
    detail: "Classifiers, rerankers, extractors: yes. Product core: not yet.",
  },
  {
    n: 3,
    chapter: 3,
    verdict: "early",
    text: "Web agents are early",
    detail: "We were here with backend agents not long ago.",
  },
];

/**
 * The two halves of the room, and what each should leave repeating.
 *
 * These are the talk's two pillars stated as people rather than as topics: the
 * browser as an agent INTERFACE is what the frontend half is being told about,
 * and the browser as an agent RUNTIME is what the AI half is. The same pair
 * names the chapters (`chapters.js` -> `pillar`), so the cold-open card and the
 * divider it points at say the same thing.
 *
 * `rollUp` names the verdicts that earn each instruction, so the closing slide
 * can be checked against the evidence rather than asserted.
 *
 * ORDER MATTERS: frontends first, because chapter 1 is theirs. Both the cold-open
 * seed slide and the closing payoff render this array as-is, so the cards always
 * follow the running order.
 */
export const AUDIENCES = [
  {
    key: "frontend",
    icon: "browser",
    who: "If you build frontends",
    claim: "Agents are increasingly your users.",
    action: "Register three tools on the thing you already ship.",
    rollUp: [1],
  },
  {
    key: "ai",
    icon: "brain",
    who: "If you build AI systems",
    claim: "A lot of the agent now fits in a tab.",
    action: "Move one piece into the tab: the index, a reranker, an extractor.",
    rollUp: [2, 3],
  },
];

/** One takeaway by its number, for `takeaway(2)` lookups in the deck. */
export const takeaway = (n) => takeaways.find((t) => t.n === n);

/**
 * Every takeaway a chapter is responsible for.
 *
 * This is what the chapter-closing slides are built from, so a takeaway cannot
 * be defined here and then quietly never land on a slide.
 */
export const byChapter = (n) => takeaways.filter((t) => t.chapter === n);
