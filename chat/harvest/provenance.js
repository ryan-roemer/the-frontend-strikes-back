/* global fetch:false */

/**
 * Where a node's text came from, and how much to trust the answer.
 *
 * THIS CANNOT BE COMPLETE, and the honest thing is to say so per node rather
 * than to average it away. `docs/deck-context-handoff.md` §3 measured the
 * ceiling: of 146 prose nodes, 39 trace exactly to a data module, 51 appear
 * verbatim exactly once in `index.html`, 10 appear more than once, 27 are too
 * short to search, and 19 do not exist as a literal anywhere.
 *
 * The 19 are not a bug. They are three properties of the deck's own source:
 *
 *   interpolation        `The frontend is ${em("back")}.` renders as one run
 *   runtime composition  "Part A - WebMCP" is built from `PARTS` and exists as
 *                        a literal nowhere
 *   structural flattening `<br />` and nested lists join text the source keeps
 *                        apart
 *
 * No amount of searching beats those, so this file does not try. It emits a
 * TIER and names it, because the consumer is a human or an agent with `grep`
 * (handoff §5), and for them a search key plus a slide number is enough while a
 * confident wrong line number is worse than nothing.
 *
 * WHY IT FETCHES `index.html`. The tiers above are only useful if you know which
 * one a node is in, and that is not derivable from the fiber tree -- "does this
 * string appear in the source, and how often" is a fact about the source. One
 * fetch and a `split().length` answers it exactly, turning "best effort" into a
 * measurement. The deleted `knowledge.js` refused to fetch `index.html` because
 * regexing `htm` template literals is fragile; that objection is about EXTRACTING
 * content and does not reach counting a literal, which has no grammar to get
 * wrong.
 *
 * Lazy and cached, and deliberately NOT part of any model view. Provenance is
 * for the person pasting a pointer into an editor. Spending model context on
 * `deck/takeaways.js -> takeaways[3].text` would buy nothing a 2B model can act
 * on.
 */
import { chapters } from "../../deck/chapters.js";
import { AUDIENCES, PARTS, VERDICTS, takeaways } from "../../deck/takeaways.js";

/**
 * Shorter than this and a string match means nothing.
 *
 * "Notes", "Deck", "TODO" and the like occur everywhere; handoff §3 counted 27
 * nodes under this bar. They still get an address and a kind -- only the search
 * tier is withheld.
 */
const MIN_SEARCHABLE = 10;

/**
 * Rendered text -> the field that holds it.
 *
 * The data modules exist so the same claim cannot drift across three slides
 * (`takeaways.js`: "Edit the claim here and all three move together"), which
 * makes them both the most reliable pointer available AND the most likely edit
 * target in the deck -- these are the six claims the talk makes. A pointer at
 * the field beats a pointer at any one of the slides rendering it.
 */
const dataPointers = () => {
  const map = new Map();
  const add = (text, pointer) => {
    if (typeof text === "string" && text.trim() && !map.has(text)) {
      map.set(text, pointer);
    }
  };

  takeaways.forEach(({ text, detail }, i) => {
    add(text, `deck/takeaways.js -> takeaways[${i}].text`);
    add(detail, `deck/takeaways.js -> takeaways[${i}].detail`);
  });
  chapters.forEach(({ title }, i) => {
    add(title, `deck/chapters.js -> chapters[${i}].title`);
  });
  AUDIENCES.forEach(({ who, claim, action }, i) => {
    add(who, `deck/takeaways.js -> AUDIENCES[${i}].who`);
    add(claim, `deck/takeaways.js -> AUDIENCES[${i}].claim`);
    add(action, `deck/takeaways.js -> AUDIENCES[${i}].action`);
  });
  for (const [key, { title }] of Object.entries(PARTS)) {
    add(title, `deck/takeaways.js -> PARTS.${key}.title`);
  }
  for (const [key, { title }] of Object.entries(VERDICTS)) {
    add(title, `deck/takeaways.js -> VERDICTS.${key}.title`);
  }
  return map;
};

let pointers = null;
let source = null;

/**
 * The deck's own source, for counting literals in.
 *
 * Fetches `/`, not `/index.html`: the dev server redirects `/foo.html` to `/foo`
 * (handoff §8), and a redirect that drops the path is a 404 you find out about
 * at the wrong moment.
 *
 * Null on failure rather than throwing. Provenance is a convenience on top of a
 * working harvest; a file:// load or an offline tab should lose the search tier,
 * not the addresses.
 */
const deckSource = async () => {
  if (source !== null) return source;
  try {
    const response = await fetch("/", { cache: "no-store" });
    source = response.ok ? await response.text() : "";
  } catch {
    source = "";
  }
  return source;
};

/**
 * The longest span of a node's text that DOES appear in the source.
 *
 * The fallback for everything the three causes above break apart. A markdown
 * bullet authored as `The page **registers** tools. The agent discovers and
 * calls them.` renders without the asterisks, so the rendered run matches
 * nothing -- but ` tools. The agent discovers and calls them.` matches exactly,
 * and that is a perfectly good thing to `grep` for.
 *
 * Word-granular rather than character-granular: a run that starts mid-word is
 * not a phrase anyone would search for, and it invites a match inside an
 * unrelated identifier. Quadratic in words, which is free at 10-30 of them and
 * only runs on the path where the whole string already failed.
 */
const longestRun = (text, html) => {
  const words = text.split(" ");
  let best = "";

  for (let i = 0; i < words.length; i += 1) {
    let run = "";
    for (let j = i; j < words.length; j += 1) {
      const next = run ? `${run} ${words[j]}` : words[j];
      if (!html.includes(next)) break;
      run = next;
    }
    if (run.length > best.length) best = run;
  }
  return best;
};

/**
 * What KIND of thing produced this node, which is knowable for every node even
 * when the text is not findable.
 */
const kindOf = (node, slide, pointer) => {
  if (pointer) return "data";
  if (node.role === "code") return "example-file";
  if (slide?.kind === "markdown") return "markdown-source";
  return "htm-inline";
};

/**
 * One node's provenance.
 *
 * `match` is the tier, and it is the field to read first:
 *
 *   data       the pointer is exact. Edit that field
 *   exact      the text appears once in `index.html`. Search for it
 *   ambiguous  it appears N times. Search, then use the slide number to choose
 *   partial    the whole run is not there but a span of it is. `search` holds
 *              that span, not the node's text -- markup or an interpolation
 *              splits the rest
 *   not-found  it is composed at runtime. `search` is null, the slide number
 *              and role are all there is, and that is the honest answer
 *   too-short  under 10 characters. Not searched, because the result would be
 *              noise rather than a location
 */
export const provenanceOf = async (node, slide) => {
  pointers ??= dataPointers();
  const pointer = pointers.get(node.text) ?? null;
  const kind = kindOf(node, slide, pointer);

  if (pointer) {
    return { kind, match: "data", pointer, search: node.text, count: 1 };
  }

  // A code pane's node text IS its filename, and `deck/examples.js` maps that to
  // a real file under `examples/`. Searching `index.html` for it would report
  // "not-found" on the one node in the deck whose source location is certain --
  // the source is not in `index.html` at all, it is its own file.
  if (kind === "example-file") {
    return {
      kind,
      match: "file",
      pointer: `examples/${node.text}`,
      search: node.text,
      count: 1,
    };
  }

  const base = { kind, pointer: null, search: node.text, file: "index.html" };
  if (node.text.length < MIN_SEARCHABLE) {
    return { ...base, match: "too-short", count: null };
  }

  const html = await deckSource();
  if (!html) return { ...base, match: "unknown", count: null };

  const count = html.split(node.text).length - 1;
  if (count === 1) return { ...base, match: "exact", count };
  if (count > 1) return { ...base, match: "ambiguous", count };

  const run = longestRun(node.text, html);
  if (run.length < MIN_SEARCHABLE) {
    // Genuinely composed at runtime -- "Part A - WebMCP" is assembled from
    // `PARTS` and is not a string anywhere. The slide number and the role are
    // the whole answer, and saying so is better than shipping a search key that
    // sends the reader to the wrong file.
    return { ...base, match: "not-found", count: 0, search: null };
  }
  return {
    ...base,
    match: "partial",
    count: html.split(run).length - 1,
    search: run,
  };
};

/** Every node's provenance, and the tier totals worth watching for drift. */
export const provenanceReport = async (slides) => {
  const rows = [];
  for (const slide of slides) {
    for (const node of slide.nodes) {
      rows.push({ ...node, provenance: await provenanceOf(node, slide) });
    }
  }

  const totals = {};
  for (const { provenance } of rows) {
    totals[provenance.match] = (totals[provenance.match] ?? 0) + 1;
  }
  return { rows, totals };
};
