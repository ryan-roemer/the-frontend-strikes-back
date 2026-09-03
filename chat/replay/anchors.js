/**
 * Which slide a fixture is about, said in terms of what is ON the slide rather than where
 * it sits in the deck.
 *
 * WHY THIS EXISTS. Every fixture used to name an absolute slide number -- `meta.slide: 9`,
 * `expect.slides: { "9": [...] }`, a receipt reading `on slide 9, bullet 4`. One slide was
 * deleted from `index.html` and fourteen of sixteen fixtures failed at once, every one of
 * them reporting a mismatch on content that was perfectly correct, one slide further down.
 * A number is a coordinate, and a coordinate into a deck being rewritten is a reference to
 * nothing.
 *
 * SO A FIXTURE DESCRIBES ITS SLIDE AND THE NUMBER IS LOOKED UP AT RUN TIME. Two ways to
 * describe one, and the choice says what the fixture is really testing:
 *
 *   BY CONTENT, when the recorded replies quote the slide -- `edit_text` with
 *   `find: "modelContext"` only means something on a slide containing that word. Written
 *   `"at": "modelContext"`, or `re:` for a pattern.
 *
 *   BY SHAPE, when they do not -- "hide the last bullet" needs four bullets so that
 *   `bullet 4` is both addressable and last, and does not care what any of them say.
 *   Written `"at": { "nodes": { "bullet": 4 } }`. This is the durable one: it survives
 *   the slide being reworded, retitled and moved.
 *
 * FIRST MATCH WINS, rather than insisting the description picks out exactly one slide.
 * Uniqueness sounds safer and is worse: the only way to make a shape unique is to pin
 * content next to it, which is the fragility this module exists to remove. A resolved
 * anchor is reported back in `report.meta.at`, so a fixture that drifted onto a slide you
 * did not mean is one line into the failure output rather than a mystery.
 *
 * PURE, AND NO IMPORTS, for the same reason as `fixture.js` beside it: `runner.js` uses it
 * in the page against a live deck, and `test/fixture.test.js` uses it under `node --test`
 * with a hand-written deck of three slides. One browser-shaped import would end the second.
 */

/** `re:` marks a pattern matched as a regular expression rather than as a substring. */
const RE = "re:";

/**
 * Does this pattern describe this text?
 *
 * CONTAINMENT for a plain string, matching `receiptMatches` in `fixture.js` rather than the
 * whole-line equality `matchSlide` uses. An anchor is looking for a word somewhere on a
 * slide, and a fixture that had to quote a full line to find its slide would be pinned to
 * that line's wording -- which is the thing being fixed here.
 */
const matches = (pattern, text) =>
  pattern.startsWith(RE)
    ? new RegExp(pattern.slice(RE.length), "m").test(String(text ?? ""))
    : String(text ?? "").includes(pattern);

/** A bare string anchor is shorthand for the commonest clause. */
const clauses = (anchor) =>
  typeof anchor === "string" ? { text: anchor } : (anchor ?? {});

const asList = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Does one slide answer to one anchor?
 *
 * EVERY CLAUSE MUST HOLD. They narrow rather than choose, so `{ title: "Takeaway", nodes:
 * { takeaway: 2 } }` is "the Takeaway slide that has two of them" -- which is how you tell
 * three identically titled chapter enders apart without naming a number.
 */
const slideMatches = (slide, anchor) => {
  const { title, text, nodes, chapter } = clauses(anchor);

  if (title !== undefined && !matches(title, slide.title)) return false;
  if (chapter !== undefined && Number(chapter) !== Number(slide.chapter)) {
    return false;
  }
  for (const pattern of asList(text)) {
    if (!matches(pattern, slide.text)) return false;
  }
  for (const [name, count] of Object.entries(nodes ?? {})) {
    // EXACT, not "at least". `{ bullet: 4 }` is chosen because it makes `bullet 4` the
    // LAST bullet, and "at least four" would happily pick a slide with seven, where
    // "hide the last bullet" resolves to `bullet 7` and the fixture's recorded reply
    // addresses the wrong node.
    if (
      slide.labels.filter((label) => label === name).length !== Number(count)
    ) {
      return false;
    }
  }
  return true;
};

/**
 * A slide number for one anchor, or a reason there isn't one.
 *
 * A NUMBER PASSES STRAIGHT THROUGH, which is the escape hatch for a fixture about a slide
 * that genuinely has no describable content -- the QR code slide is one text node and a
 * picture. It is also what makes this safe to adopt one fixture at a time.
 */
export const resolveAnchor = (anchor, deck) => {
  if (typeof anchor === "number") return { slide: anchor };

  const found = deck.find((slide) => slideMatches(slide, anchor));
  if (found) return { slide: found.number };

  return {
    reason: `no slide matches ${JSON.stringify(anchor)}`,
  };
};

/**
 * `meta` -> the numbers a fixture's placeholders stand for.
 *
 * `at` IS THE ONE EVERY FIXTURE HAS: the slide the deck is moved to before the first turn,
 * because `resolveTarget` reads the slide on screen and "the heading" means nothing until
 * the deck is where the fixture was captured. `meta.anchors` adds the others -- a fixture
 * that navigates somewhere needs to name where it lands, and `{ch4}` in a receipt is that.
 *
 * `total` comes from the deck rather than an anchor, for the one assertion that is about
 * the deck's size instead of its content: `go_to_slide` reports "slide 23 of 34".
 */
export const resolveAnchors = (meta, deck, { count = deck.length } = {}) => {
  const values = { total: count };
  const failures = [];

  const named = {
    ...(meta.anchors ?? {}),
    ...(meta.at ? { at: meta.at } : {}),
  };
  for (const [name, anchor] of Object.entries(named)) {
    const { slide, reason } = resolveAnchor(anchor, deck);
    if (slide === undefined) failures.push(`anchor \`${name}\`: ${reason}`);
    else values[name] = slide;
  }

  return { values, failures };
};

/**
 * `{at}`, `{at+1}`, `{total}` -> a number.
 *
 * ONLY KNOWN NAMES ARE SUBSTITUTED, and that is not a nicety: these fixtures carry
 * JavaScript in their recorded replies, and `document.modelContext.registerTool({` is a
 * brace followed by a newline. Replacing only names that resolved leaves every other brace
 * in the file exactly as it was, and a typo'd `{atx}` survives into the failure message
 * where it is readable, rather than turning into `undefined` or throwing.
 */
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)([+-]\d+)?\}/gi;

/**
 * Is this whole string one placeholder?
 *
 * FOR THE LAYER THAT READS A FIXTURE WITHOUT A DECK. `test/fixture.test.js` checks every
 * fixture's claims with no browser at all, so it sees `expect.slides` still keyed `{at}` --
 * unresolved, because there is nothing to resolve against. `readFixture` has to tell that
 * apart from a typo, and this is the one definition of the syntax both sides ask.
 */
export const isPlaceholder = (text) =>
  new RegExp(`^${PLACEHOLDER.source}$`, "i").test(String(text));

const fillString = (text, values) =>
  text.replace(PLACEHOLDER, (whole, name, offset) => {
    const base = values[name];
    if (typeof base !== "number") return whole;
    return String(base + (offset ? Number(offset) : 0));
  });

/**
 * Substitute placeholders everywhere in a fixture, KEYS INCLUDED.
 *
 * The keys matter as much as the values: `expect.slides` is keyed by slide number, so
 * `{ "{at}": [...] }` is how a golden state stops naming a coordinate.
 *
 * SUBSTITUTED INTO THE RECORDED REPLIES TOO, which looks surprising and is the point. A
 * reply that says `{"target": "{at}.2"}` is the model addressing node 2 of the slide the
 * fixture is about -- the same claim it made when recorded as `15.2`, minus the assumption
 * that the slide is still fifteenth. `test/fixture.test.js` cross-checks the reply against
 * `expect.calls` before any of this runs, comparing template to template, so the two cannot
 * drift apart.
 */
export const fill = (value, values) => {
  if (typeof value === "string") return fillString(value, values);
  if (Array.isArray(value)) return value.map((one) => fill(one, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [
        fillString(key, values),
        fill(one, values),
      ]),
    );
  }
  return value;
};

/**
 * A slide number -> the placeholder that stands for it, for a RECORDING pass.
 *
 * Recording writes `expect` blocks back into a fixture (`recordedExpectations`), and
 * writing concrete numbers back would undo this module one recording at a time. The
 * nearest anchor wins, and ties go to the shorter name, so a slide two anchors can both
 * reach comes out as `{at}` rather than `{ch4+3}`.
 */
export const unfill = (number, values) => {
  const best = Object.entries(values)
    .filter(([name]) => name !== "total")
    .map(([name, at]) => ({ name, offset: Number(number) - at }))
    .sort(
      (a, b) =>
        Math.abs(a.offset) - Math.abs(b.offset) ||
        a.name.length - b.name.length,
    )[0];

  if (!best || Math.abs(best.offset) > 2) return String(number);
  if (!best.offset) return `{${best.name}}`;
  return `{${best.name}${best.offset > 0 ? "+" : ""}${best.offset}}`;
};
