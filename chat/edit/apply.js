/**
 * Ops in, deck changes out. The ONLY module that writes to the deck.
 *
 * Every result carries a `label` for the receipt, generated from what was ACTUALLY
 * APPLIED rather than from what was asked for.
 *
 * THE RECEIPT-LIES FAMILY is why the validation here is not ceremony. A schema can only
 * check shape, so accepting any non-empty string as a CSS value produces "Done." for a
 * change nothing on the slide reflects -- worse than a refusal, because the presenter
 * stops looking:
 *
 *   - `font-size: bigger` -- not a CSS value, so the declaration is dropped on parse.
 *   - `font-size: larger` -- valid CSS, and it makes the title-slide subtitle SMALLER,
 *     46px to 19.2px, because `larger` resolves against the PARENT.
 *   - `color` on the display title -- painted by a gradient clipped to the glyphs, so
 *     setting `color` changes the computed value and nothing else.
 *
 * The rule to apply to the next one that looks like these: ASK THE BROWSER, DON'T TRUST
 * THE STRING. `CSS.supports` and `getComputedStyle` answer all three exactly.
 *
 * Never throws. A bad op is a message, not a crash.
 */
import { resolveNode } from "../harvest/index.js";
import { normalize } from "../harvest/nodes.js";
import { describeNode } from "../harvest/views.js";
import {
  captureBaseline,
  dropSlide,
  isMixed,
  mainTextValue,
  push,
  pushAll,
  reset,
  runsOf,
  undo,
} from "./patches.js";

/**
 * The properties an edit may set.
 *
 * An allowlist rather than "any CSS property", and the SAME list builds the
 * tool's `inputSchema` enum -- so a value the schema accepts is a value this
 * accepts, and the two cannot drift into disagreement.
 */
export const STYLE_PROPS = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "line-height",
  "text-align",
  "text-transform",
  "text-decoration",
  "opacity",
  "border-radius",
  // "Hide that bullet" WITHOUT TOUCHING THE CHILD LIST, which is the only safe
  // way to do it: removing a node React's fiber still references throws
  // `NotFoundError` on the next commit and unmounts the deck. A CSS patch is
  // reversible, survives a remount, and costs nothing structural.
  //
  // Both, because they are different answers: `visibility: hidden` keeps the
  // space so the rest of the slide does not move, `display: none` reflows.
  "display",
  "visibility",
];

/** Custom properties the deck itself defines, so an override has something to override. */
export const CSS_VARS = [
  "--chapter-accent",
  "--chapter-accent-base",
  "--surface-1",
  "--surface-2",
  "--hairline",
  "--muted",
];

/**
 * A layout guard for the 1366x768 canvas.
 *
 * REJECTED, never truncated: a mid-word cut landing on a live slide is worse
 * than a refusal.
 */
export const MAX_TEXT = 140;

/**
 * Turn "bigger" into a size that is actually bigger.
 *
 * CSS's own `larger` and `smaller` resolve against the PARENT's font size, not the
 * element's: the title-slide subtitle computes to 46px inside a 16px container, so
 * `font-size: larger` takes it to 19.2px -- "make it bigger" shrinking it by half, with a
 * receipt reporting success.
 *
 * Resolved here against the element's OWN computed size, which also makes the receipt
 * report the px the slide got rather than a keyword whose meaning depends on where it
 * landed. Font-size only: it is where "bigger" is asked for and where the trap bites.
 */
const RELATIVE_SIZES = {
  bigger: 1.2,
  larger: 1.2,
  smaller: 1 / 1.2,
  tinier: 1 / 1.2,
};

const resolveSize = (prop, value, el) => {
  // `hasOwn` rather than a bare lookup: `RELATIVE_SIZES["constructor"]` returns a
  // function, which multiplies to `NaNpx`. That currently degrades safely into the
  // `CSS.supports` refusal below, but only by accident.
  const key = String(value).toLowerCase();
  const factor = Object.hasOwn(RELATIVE_SIZES, key)
    ? RELATIVE_SIZES[key]
    : null;
  if (prop !== "font-size" || !factor || !el) return value;

  const current = parseFloat(getComputedStyle(el).fontSize);
  if (!Number.isFinite(current) || current <= 0) return value;
  return `${Math.round(current * factor)}px`;
};

/**
 * Is this element's text painted by a background rather than by `color`?
 *
 * The deck's display title is `background-clip: text` with a gradient and both
 * `color` and `-webkit-text-fill-color` transparent, so the glyphs show the
 * gradient through. Setting `color` on it does exactly nothing visible.
 */
const paintedByBackground = (el) => {
  if (!el) return false;
  const cs = getComputedStyle(el);
  const clip = cs.webkitBackgroundClip || cs.backgroundClip;
  return clip === "text" && (cs.backgroundImage || "none") !== "none";
};

/**
 * The declarations needed to make a colour change actually show.
 *
 * `-webkit-text-fill-color` WINS over `color` wherever both are set, so it has
 * to be part of any colour change or gradient-painted text ignores us. Emitted
 * for every element, not just the gradient ones: on ordinary text it resolves to
 * the same colour and changes nothing, which is a much better deal than sniffing
 * the element and getting it wrong.
 */
const colourDeclarations = (value) =>
  `color: ${value}; -webkit-text-fill-color: ${value}`;

const fail = (message) => ({ ok: false, message });
const done = (label, note) => ({ ok: true, label, note });

/** Resolve a node id to `{ node, el }`, or a refusal. */
const target = (id) => {
  const node = resolveNode(id);
  if (!node) return { error: fail(`No node ${id} — the deck may have moved.`) };
  if (!node.element) {
    return { error: fail(`${id} has no element on screen right now.`) };
  }
  return { node, el: node.element };
};

export const setText = (id, text) => {
  const value = String(text ?? "");
  if (!value.trim()) {
    // The refusal stands -- a node blanked by rewriting leaves an empty box where the
    // deck expects words. But this is where "remove the heading" arrives, so it says
    // which argument DOES delete rather than only that this one does not.
    //
    // `retry: true` because both alternatives it names are reliable, which is the bar
    // `act/receipt.js` `retryable` sets. Asked to "hide the last bullet" the model sent
    // `edit_text` with an empty `text`, read this, and had nothing ask it again -- the
    // turn ended on a refusal that was already holding the answer. The retry can dispatch
    // a DIFFERENT tool (`respond.js` re-resolves the name), so "style it `display: none`"
    // is advice the model can actually take.
    return {
      ...fail(
        "Give me some text. To delete words, pass `find` with an empty `text`; to hide the whole thing, style it `display: none`.",
      ),
      retry: true,
    };
  }
  if (value.length > MAX_TEXT) {
    return fail(
      `That is ${value.length} characters; anything over ${MAX_TEXT} overflows the slide. Shorten it and try again.`,
    );
  }

  const found = target(id);
  if (found.error) return found.error;

  // The baseline is the TEXT NODE's own value, not the harvested node text --
  // they differ wherever there is inline markup. See `mainTextValue`.
  const original = mainTextValue(found.el);
  if (!original) return fail(`${id} has no editable text run.`);

  captureBaseline(id, `text:${original.index}`, {
    kind: "text",
    index: original.index,
    value: original.value,
  });
  const was = found.node.text;
  push({
    kind: "text",
    id,
    runIndex: original.index,
    text: value,
    label: `text ${id} → "${value}"`,
  });

  // WHAT THE SLIDE NOW SAYS, read back off the element rather than echoed from
  // the argument. On the third of this deck that carries inline markup the two
  // are not the same string: setting 9.3 -- `#text "One API: "` plus
  // `<code>document.modelContext</code>` -- to "New wording" leaves the slide
  // reading "New wordingdocument.modelContext", and a receipt quoting the
  // argument reports a change the deck did not make.
  //
  // BOTH SIDES, and the new one last. `describeNode` reads the fiber tree, which
  // still holds the authored wording -- React never learns about a `nodeValue`
  // write, which is exactly what makes the edit durable. So a receipt built from
  // it alone quotes the text that was just replaced and reads as a no-op.
  const now = normalize(found.el.textContent ?? "");
  return done(
    `${describeNode(id) ?? `${id} — "${was}"`} → "${now}"`,
    isMixed(found.el)
      ? `${id} has inline markup, so "${value}" replaced only its main text run. Use find to change part of it instead.`
      : null,
  );
};

/** `find`, as a regex matching it literally, every occurrence. */
const literally = (find, matchCase) =>
  new RegExp(
    find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    matchCase ? "g" : "gi",
  );

/**
 * What replacing `find` in one node would do -- computed, not applied.
 *
 * SEPARATE FROM APPLYING because a replace across a slide has to land as ONE
 * undoable group, and it cannot know its own label until every node has been
 * measured. Planning first also means a node that would overflow refuses before
 * anything on screen has moved, rather than halfway through.
 */
const planReplace = (id, find, replacement, matchCase) => {
  const found = target(id);
  if (found.error) return { ok: false, message: found.error.message };

  const runs = runsOf(found.el);
  const next = new Map();
  let hits = 0;

  for (const run of runs) {
    // A FRESH REGEX PER USE. A `/g` pattern carries `lastIndex` between calls,
    // so reusing one makes `match` on the second run start from wherever the
    // first one stopped -- occurrences silently skipped, at no fixed rate.
    const matched = run.value.match(literally(find, matchCase));
    if (!matched) continue;
    hits += matched.length;
    next.set(
      run.index,
      run.value.replace(literally(find, matchCase), replacement),
    );
  }

  // Not an error: a node that does not contain the phrase is simply not one of
  // the nodes this call is about.
  if (!hits) return { ok: false, skipped: true };

  const before = normalize(found.el.textContent ?? "");
  const after = normalize(
    runs.map((run) => next.get(run.index) ?? run.value).join(""),
  );

  // THE GUARD FIRES ON GROWTH THIS CALL CAUSED, not on absolute length. A code
  // pane is already far past `MAX_TEXT`, and refusing to rename a symbol inside
  // one because of a limit that was already exceeded before anybody asked would
  // be a layout guard blocking an edit that cannot affect the layout.
  if (after.length > MAX_TEXT && after.length > before.length) {
    return {
      ok: false,
      message: `Replacing "${find}" in ${id} would make it ${after.length} characters; anything over ${MAX_TEXT} overflows the slide.`,
    };
  }

  return {
    ok: true,
    id,
    hits,
    before,
    after,
    runs: [...next.keys()],
    values: runs,
    patches: [...next].map(([index, text]) => ({
      kind: "text",
      id,
      runIndex: index,
      text,
      label: `replace in ${id}`,
    })),
  };
};

/**
 * Replace a phrase wherever it appears across a set of nodes.
 *
 * SAFER THAN WHOLE-NODE REPLACEMENT ON MIXED NODES, which is the part worth
 * knowing: this rewrites each text run in place, so a `<code>` or `<em>` beside
 * the words being changed keeps both its markup and its text. `setText` can only
 * write the longest run and has to report that it did.
 *
 * ONE GROUP for the whole call, so "change every WebMCP to web tools" is one
 * press of undo rather than eleven.
 */
export const replaceText = (
  ids,
  find,
  replacement,
  { matchCase = false } = {},
) => {
  const needle = String(find ?? "");
  if (!needle) return fail("Give me something to find.");
  if (replacement === undefined || replacement === null) {
    return fail("Give me the text to put in its place.");
  }
  const value = String(replacement);

  const plans = [];
  const refusals = [];
  for (const id of ids) {
    const plan = planReplace(id, needle, value, matchCase);
    if (plan.ok) plans.push(plan);
    else if (!plan.skipped) refusals.push(plan.message);
  }

  if (!plans.length) {
    if (refusals.length) return fail(refusals.join(" "));

    // IS IT THERE, JUST NOT IN ONE PIECE? `planReplace` matches within a single text run,
    // and a syntax-highlighted code pane is one run per token -- `name`, `: `,
    // `"search_documents"` are three. So `find: 'name: "search_documents"'` is plainly
    // visible on the slide and matches nothing, and `Nothing in range contains …` reads as
    // the deck being wrong about its own contents.
    //
    // Reported as ITS OWN REFUSAL, naming the fix, because the fix is reliable: a single
    // identifier is a single token and does match. `retry: true` lets the model take that
    // advice without the user retyping the request -- see `act/receipt.js` `retryable`.
    const spanning = ids.find((id) => {
      const found = target(id);
      if (found.error) return false;
      const whole = found.el.textContent ?? "";
      return matchCase
        ? whole.includes(needle)
        : whole.toLowerCase().includes(needle.toLowerCase());
    });
    if (spanning) {
      return {
        ...fail(
          `"${needle}" is on the slide but spans several separately-styled pieces of text, so it cannot be replaced in one go. ` +
            `Try a single word or identifier from it — in a code sample, something like a name or a value on its own.`,
        ),
        retry: true,
      };
    }

    return fail(`Nothing in range contains "${needle}".`);
  }

  // BEFORE `pushAll`, which rebuilds. Capturing afterwards would record the
  // replacement as the deck's original value, and reset would restore the edit.
  for (const plan of plans) {
    for (const index of plan.runs) {
      captureBaseline(plan.id, `text:${index}`, {
        kind: "text",
        index,
        value: plan.values.find((run) => run.index === index)?.value ?? "",
      });
    }
  }

  const hits = plans.reduce((total, plan) => total + plan.hits, 0);
  const nodesText = `${plans.length} node${plans.length === 1 ? "" : "s"}`;
  // AN EMPTY REPLACEMENT IS A REMOVAL, and it gets its own verb in both the undo label
  // and the receipt. `"WebMCP" → "" in 1 node` is accurate and unreadable -- and this
  // string is what a presenter skims mid-talk to check the deck did what they asked.
  const label = value
    ? `"${needle}" → "${value}" in ${nodesText}`
    : `removed "${needle}" from ${nodesText}`;
  pushAll(
    plans.flatMap((plan) => plan.patches),
    label,
  );

  return {
    ...done(
      `${
        value ? `Replaced "${needle}" with "${value}"` : `Removed "${needle}"`
      } — ${hits} occurrence${hits === 1 ? "" : "s"} across ${nodesText}.`,
      refusals.length ? `Skipped: ${refusals.join(" ")}` : null,
    ),
    hits,
    nodes: plans.map(({ id, hits: count, before, after }) => ({
      id,
      hits: count,
      before,
      after,
    })),
  };
};

/**
 * "color: yellow; text-decoration: underline" -> the pairs it names.
 *
 * A CSS DECLARATION LIST IS THE ARGUMENT because of who fills it in. The tool used
 * to take `property` and `value` as two arguments, which cost a whole call per
 * declaration -- so "make this yellow and underline it", one thing a person says,
 * was two tool calls and two undos. A 2B model choosing and filling in one shot
 * (`mcp/tools.js`) does not get a second shot.
 *
 * Losing the schema `enum` on `property` is the trade, and it is a smaller loss than
 * it looks: `setStyles` still refuses an unknown property with the full list, so the
 * constraint moved from the schema to the receipt rather than disappearing. What is
 * gained is a syntax every model has seen a million times and cannot really get
 * wrong, versus two co-dependent arguments it has to keep aligned.
 *
 * TOLERANT ABOUT SHAPE, STRICT ABOUT CONTENT. A trailing semicolon, a missing one,
 * odd spacing and wrapping braces are all accepted, because none of them is
 * ambiguous. Anything past the first colon is the value, so `background-image:
 * url(a:b)` survives; a declaration with no colon at all is dropped here and
 * counted, so the receipt can say what it ignored rather than silently doing less
 * than it was asked.
 */
export const parseDeclarations = (style) => {
  const pairs = [];
  const dropped = [];

  for (const chunk of String(style ?? "").split(";")) {
    const part = chunk
      .trim()
      .replace(/^[{]+|[}]+$/g, "")
      .trim();
    if (!part) continue;

    const colon = part.indexOf(":");
    if (colon === -1) {
      dropped.push(part);
      continue;
    }
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!prop || !value) {
      dropped.push(part);
      continue;
    }
    pairs.push({ prop, value });
  }

  return { pairs, dropped };
};

/**
 * One declaration against one node, validated and resolved but NOT applied.
 *
 * Split out of the old `setStyle` so that a multi-node, multi-declaration change can
 * be checked in full before any of it lands. Returns the patch to push rather than
 * pushing it, which is what lets `setStyles` put the whole change in one group.
 */
const planStyle = (id, prop, value) => {
  const found = target(id);
  if (found.error) return { ok: false, message: found.error.message };

  const resolved = resolveSize(prop, value, found.el);

  // Ask the browser whether the declaration is even real. Without this,
  // "make it bigger" filled in `font-size: bigger` -- not a CSS value, so it was
  // dropped on parse, nothing moved, and the receipt still said "Done."
  if (!CSS.supports(prop, resolved)) {
    return { ok: false, message: `"${value}" isn't a value ${prop} accepts.` };
  }

  return {
    ok: true,
    resolved,
    gradient: prop === "color" && paintedByBackground(found.el),
    patch: {
      kind: "css",
      id,
      selector: `[data-deck-ref="${id}"]`,
      declarations:
        prop === "color"
          ? colourDeclarations(resolved)
          : `${prop}: ${resolved}`,
      label: `${prop} ${id} → ${resolved}`,
    },
  };
};

/**
 * Style one node or a whole group, with one or several declarations.
 *
 * ONE CALL IS ONE EDIT AND ONE UNDO, which is why this plans everything and then
 * calls `pushAll` once. Styling four bullets yellow is one thing the presenter did,
 * and making them press undo four times describes the implementation rather than the
 * change -- the same rule `replaceText` already follows.
 *
 * A BAD PROPERTY REFUSES THE WHOLE CALL; a bad VALUE only skips its own declaration.
 * The asymmetry is deliberate. An unrecognised property means the request was
 * misunderstood, and half-applying a misunderstanding is how you get a receipt the
 * presenter stops trusting. An unusable value on one node of four is a partial
 * result worth keeping, provided the receipt says so -- which is what `skipped` is
 * for.
 */
export const setStyles = (ids, style) => {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return fail("Nothing to style.");

  const { pairs, dropped } = parseDeclarations(style);
  if (!pairs.length) {
    // A WORD WHERE A DECLARATION GOES, which is what "hide the last bullet" turns into
    // once the model has picked the right tool: `style_node({ target: "the bullets",
    // style: "remove" })`. The intent is unmistakable and the correction is a fixed form,
    // so this is `retry`-worthy on `receipt.js`'s own test -- the message already spells
    // out the shape, and without the flag a turn that got everything but the syntax right
    // ends on a refusal.
    return {
      ...fail(
        `I couldn't read "${style}" as a style. Give me declarations like "color: yellow; text-decoration: underline". To take something off the slide, that is "display: none".`,
      ),
      retry: true,
    };
  }

  const unknown = pairs.find(({ prop }) => !STYLE_PROPS.includes(prop));
  if (unknown) {
    // The valid set is named in full, which is the same reliable-correction bar.
    return {
      ...fail(
        `I can't set "${unknown.prop}". I can set: ${STYLE_PROPS.join(", ")}.`,
      ),
      retry: true,
    };
  }

  const patches = [];
  const applied = [];
  const skipped = [];
  let gradient = false;

  for (const id of list) {
    for (const { prop, value } of pairs) {
      const plan = planStyle(id, prop, value);
      if (!plan.ok) {
        skipped.push(plan.message);
        continue;
      }
      patches.push(plan.patch);
      applied.push({ id, property: prop, value: plan.resolved });
      gradient = gradient || plan.gradient;
    }
  }

  // EVERY declaration failing is a refusal, not a partial success. There is nothing
  // on the slide to show for it, so reporting "done" would be the receipt lie this
  // module exists to prevent.
  if (!patches.length) {
    return fail(skipped[0] ?? `Nothing on the deck took "${style}".`);
  }

  const said = applied
    .map(({ property, value }) => `${property}: ${value}`)
    // Four bullets turned yellow is "color: yellow", said once -- the per-node
    // repetition is in `applied` for anything that wants it.
    .filter((line, index, all) => all.indexOf(line) === index)
    .join("; ");
  const where =
    list.length === 1
      ? (describeNode(list[0]) ?? list[0])
      : `${list.length} nodes`;

  pushAll(patches, `style ${where} → ${said}`);

  return {
    ...done(
      `${said} on ${where}`,
      [
        gradient
          ? "That heading was painted with a gradient; a flat colour replaces that treatment."
          : null,
        dropped.length ? `Ignored: ${dropped.join(", ")}.` : null,
        skipped.length ? `Skipped: ${skipped.join(" ")}` : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    ),
    applied,
  };
};

export const setVariable = (name, value, scope, chapter) => {
  if (!name) {
    // Named separately from the unknown-name case: a MISSING name usually means
    // the caller meant a single element, and `I can't change "undefined"` sends
    // the reader looking for a broken variable instead of a misrouted request.
    return fail("Which variable? Try one of: " + CSS_VARS.join(", "));
  }
  if (!CSS_VARS.includes(name)) {
    return fail(`I don't know "${name}". I know: ${CSS_VARS.join(", ")}.`);
  }
  if (!String(value ?? "").trim()) return fail("Give me a value.");

  // The chapter is read from the DECK rather than taken from the caller: it
  // already knows which chapter it is on, and asking for a number it cannot see
  // is an invitation to guess.
  if (scope === "chapter" && !chapter) {
    return fail(
      "This slide doesn't belong to a chapter, so there's no chapter to scope to. Try the whole deck instead.",
    );
  }

  const selector = scope === "chapter" ? `.ch-${chapter}` : ":root";
  push({
    kind: "css",
    selector,
    declarations: `${name}: ${value}`,
    label: `${name} → ${value}${scope === "chapter" ? ` (chapter ${chapter})` : ""}`,
  });

  return done(
    `${name} → ${value}${scope === "chapter" ? ` for chapter ${chapter}` : " across the deck"}`,
  );
};

export const undoEdit = () => {
  const undone = undo();
  return undone ? done(`Undid: ${undone.label}`) : fail("Nothing to undo.");
};

export const resetEdits = () => {
  const count = reset();
  return done(
    count
      ? `Reset ${count} edit${count === 1 ? "" : "s"}. The deck is back as it shipped.`
      : "There was nothing to reset.",
  );
};

/**
 * Put one slide back, leaving every other slide's edits alone.
 *
 * The common repair during a talk: something on the slide currently up is wrong,
 * and undoing one step at a time would walk back changes on slides nobody is
 * looking at.
 */
export const resetSlide = (slide) => {
  const count = dropSlide(slide);
  return count
    ? done(
        `Reset ${count} change${count === 1 ? "" : "s"} on slide ${slide}. The rest of the deck is untouched.`,
      )
    : fail(`Nothing has been changed on slide ${slide}.`);
};
