/**
 * A phrase a person said -> the node they meant.
 *
 * "The second bullet", "the WebMCP one", "the heading". This is the last link in
 * the chain that starts at an utterance and ends at a DOM element, and it is the
 * only one that can be WRONG rather than merely absent -- so its job is as much
 * to report doubt as to resolve.
 *
 * CONTENT BEFORE POSITION, which is the whole design. "The WebMCP bullet" is
 * self-verifying: the substring is either in exactly one node's text or it is
 * not, and being wrong is not one of the outcomes. "The second bullet" is not
 * self-verifying -- there is always a second bullet, so a mistake about which
 * numbering is meant returns a confident wrong answer. Text first, ordinals as
 * the fallback.
 *
 * IT NEVER PICKS AMONG EQUALS. Two nodes matching means `match: "ambiguous"` and
 * both candidates, for the caller to ask about. Slide 7 carries "TODO: session +
 * when" three times and slide 31 carries "TODO" three times, so this is not a
 * hypothetical -- something has to happen there, and choosing the first is the
 * one option that cannot be recovered from.
 *
 * IN JS, NOT IN THE MODEL, for the same reason `views.js` chooses the view in JS:
 * a deterministic rule cannot hallucinate, and neither provider offers
 * grammar-constrained decoding to keep a 2B model inside the lines
 * (`docs/chat-handoff.md` §10). The model's job is to pick an id off a roster it
 * can see; this file's job is to let a HUMAN skip that step and be understood
 * anyway.
 */
import { harvestSlide } from "./index.js";
import { normalize } from "./nodes.js";
import { position } from "./views.js";

/**
 * What people call things -> the roles that satisfy it.
 *
 * The minimum needed to make the ordinal and bare-role tiers work at all, not a
 * full synonym table. Every target is a role that `nodes.js` actually emits --
 * an alias pointing at a role nothing carries is an alias that silently never
 * matches.
 *
 * `heading` is the load-bearing one: the deck has no `<h1>`, so a user saying
 * "heading" means the thing `roleOf` calls a `title`.
 */
const ALIASES = new Map([
  ["heading", ["title", "heading", "subtitle", "chapter title"]],
  ["title", ["title", "chapter title"]],
  ["subtitle", ["subtitle"]],
  ["bullet", ["bullet"]],
  ["sub-bullet", ["bullet"]],
  ["subbullet", ["bullet"]],
  ["item", ["bullet"]],
  ["point", ["bullet"]],
  ["line", ["text", "bullet"]],
  ["text", ["text"]],
  ["paragraph", ["text"]],
  ["eyebrow", ["eyebrow"]],
  ["label", ["card label", "eyebrow"]],
  ["takeaway", ["takeaway", "takeaway detail"]],
  ["caption", ["caption"]],
  ["quote", ["quote"]],
  ["code", ["code"]],
  ["url", ["demo url"]],
  ["link", ["demo url"]],
  ["row", ["matrix row"]],
]);

/** Ordinal words, plus `last` as a sentinel resolved against the group size. */
const ORDINALS = new Map([
  ["first", 1],
  ["1st", 1],
  ["one", 1],
  ["second", 2],
  ["2nd", 2],
  ["two", 2],
  ["third", 3],
  ["3rd", 3],
  ["three", 3],
  ["fourth", 4],
  ["4th", 4],
  ["four", 4],
  ["fifth", 5],
  ["5th", 5],
  ["five", 5],
  ["sixth", 6],
  ["6th", 6],
  ["six", 6],
  ["seventh", 7],
  ["7th", 7],
  ["eighth", 8],
  ["8th", 8],
  ["ninth", 9],
  ["9th", 9],
  ["tenth", 10],
  ["10th", 10],
]);

const LAST = new Set(["last", "final"]);

const clean = (phrase) => normalize(String(phrase ?? "")).toLowerCase();

const result = (match, nodes, phrase, note = null) => ({
  match,
  nodes,
  phrase,
  note,
});

/**
 * Tier 1 -- the text is in the phrase.
 *
 * Matched BOTH WAYS: the phrase may quote a fragment of a long bullet ("the
 * WebMCP one"), or it may be the whole node text pasted back with a word
 * changed. Neither direction alone covers both, and both are cheap.
 *
 * Shortest match wins among nested hits. "One API" matching a node whose whole
 * text is "One API: document.modelContext" is a better answer than the same
 * phrase matching a paragraph that happens to quote it, and the shorter node is
 * the more specific one.
 */
const byText = (nodes, phrase) => {
  const needle = clean(phrase);
  if (needle.length < 3) return [];

  const hits = nodes.filter((node) => {
    const hay = clean(node.text);
    return hay.includes(needle) || needle.includes(hay);
  });
  if (hits.length < 2) return hits;

  const shortest = Math.min(...hits.map((n) => n.text.length));
  const best = hits.filter((n) => n.text.length === shortest);
  // Only collapse to the shortest when it is UNIQUELY shortest. Two nodes of
  // equal length matching the same phrase is real ambiguity, not a tie to break.
  return best.length === 1 ? best : hits;
};

/**
 * The role a phrase names, if any, as the set of roles that satisfy it.
 *
 * Longest alias first, so "sub-bullet" is not consumed by "bullet".
 */
const rolesIn = (words) => {
  const keys = [...ALIASES.keys()].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (words.includes(key)) return { key, roles: ALIASES.get(key) };
  }
  return null;
};

/** The depth a phrase implies: sub-anything is 2, a named list role is 1. */
const depthIn = (key, roles) => {
  if (key === "sub-bullet" || key === "subbullet") return 2;
  return roles.includes("bullet") ? 1 : null;
};

/**
 * Tier 2 -- role plus an ordinal, counted the way the slide reads.
 *
 * The ordinal resolves against `roleOrdinal`, which `addressNodes` scopes by
 * depth. That is what makes "the fourth bullet" the fourth TOP-LEVEL bullet on
 * slide 9 rather than the first sub-bullet, which is what a flat count gives
 * once three sub-items are emitted between the third and the fourth.
 */
const byOrdinal = (nodes, words) => {
  const named = rolesIn(words);
  if (!named) return null;

  // The depth carries the whole sub-bullet-vs-bullet distinction, so the pool is
  // just role plus depth. "sub-bullet" pins depth 2, "bullet" pins depth 1, and
  // a role that has nothing to do with lists pins nothing.
  const depth = depthIn(named.key, named.roles);
  const pool = nodes.filter(
    (node) =>
      named.roles.includes(node.role) &&
      (depth === null || node.depth === depth),
  );
  if (!pool.length) return null;

  const digits = words.match(/\b(\d{1,2})\b/);
  const word = words.split(" ").find((w) => ORDINALS.has(w));
  const wantsLast = words.split(" ").some((w) => LAST.has(w));

  let index = null;
  if (wantsLast) index = pool.length;
  else if (word) index = ORDINALS.get(word);
  else if (digits) index = Number(digits[1]);
  if (index === null) return { pool, hit: null };

  const hit = pool.find((node) => node.roleOrdinal === index);
  return { pool, hit: hit ?? null, index };
};

/**
 * A phrase -> the node it names, on one slide.
 *
 * `slide` defaults to whatever is on screen, so "the second bullet" means what a
 * presenter looking at the deck would mean. Pass a number to resolve against a
 * slide the user named instead -- `selectView` already extracts one.
 *
 * `match` is the field to branch on:
 *
 *   text       one node's text contains the phrase, or vice versa. The strongest
 *              answer, because it could not have been confidently wrong
 *   ordinal    role plus a position, counted per depth
 *   role       the phrase named a role the slide has exactly one of
 *   ambiguous  several candidates, all in `nodes`. ASK -- do not pick
 *   none       nothing matched. `nodes` holds the slide's roster so a caller can
 *              offer it rather than saying "no"
 */
export const locate = (phrase, { slide } = {}) => {
  // ONE TEST FOR "WAS A SLIDE GIVEN", USED CONSISTENTLY. This was `slide ??
  // position().slide` followed by `number ? harvestSlide(number) : null`, which
  // disagree about zero: `??` treats 0 as provided, truthiness treats it as
  // absent. So `locate(phrase, { slide: 0 })` reported "no slide" -- the note
  // meant for an unreachable deck -- and the caller rendered it as "no slide on
  // slide 0". Callers should reject an out-of-range slide before this, but the
  // two lines still have to mean the same thing.
  const given = slide !== undefined && slide !== null;
  const number = given ? Number(slide) : position().slide;
  const said = clean(phrase);
  const harvested = Number.isInteger(number) ? harvestSlide(number) : null;
  const nodes = harvested?.nodes ?? [];

  if (!nodes.length) {
    return result(
      "none",
      [],
      said,
      Number.isInteger(number)
        ? `slide ${number} has nothing on it`
        : "no slide",
    );
  }

  const text = byText(nodes, said);
  if (text.length === 1) return result("text", text, said);

  const ordinal = byOrdinal(nodes, said);
  if (ordinal?.hit) return result("ordinal", [ordinal.hit], said);

  // Tier 3: a role with exactly one instance needs no ordinal -- "the heading"
  // on a slide with one heading is unambiguous even though nothing counted.
  if (ordinal?.pool?.length === 1) return result("role", ordinal.pool, said);

  // An ordinal that overshot is a MISS, not an ambiguity: "the fifth bullet"
  // where there are four is a specific wrong belief, and offering four
  // candidates implies one of them is the fifth.
  if (ordinal?.index && !ordinal.hit) {
    const named = rolesIn(said)?.key ?? "match";
    return result(
      "none",
      ordinal.pool,
      said,
      `there ${ordinal.pool.length === 1 ? "is" : "are"} only ${ordinal.pool.length} ${named}${ordinal.pool.length === 1 ? "" : "s"} on this slide`,
    );
  }

  if (text.length > 1) return result("ambiguous", text, said, "text matched");
  if (ordinal?.pool?.length > 1) {
    return result("ambiguous", ordinal.pool, said, "role matched, no position");
  }
  return result("none", nodes, said);
};
