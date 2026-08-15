/**
 * The tools themselves.
 *
 * Shaped to match what the deck TEACHES, because the code panes on slides 10-12
 * are on screen while this is running: `{ name, description, inputSchema,
 * execute }` per `examples/register-tool.js`, and the content-block return of
 * `examples/tool-handler.js` -- `{ content: [{ type: "text", text }] }`, or
 * `{ isError: true, content: [...] }`. If those examples and this file ever
 * disagree, the examples are the contract and this is the bug.
 *
 * DESCRIPTIONS ARE PROMPT ENGINEERING, which is the deck's own line about this
 * exact API (slide 10's notes: "Descriptions are prompt engineering. The model
 * reads them to decide"). They are written for an agent choosing between
 * fourteen tools, not for a reader who already knows what the deck is.
 *
 * ENUMS WHERE THE ANSWER IS CLOSED, which is the deck's other line ("`sortBy` is
 * an enum: constrain the agent, don't hope it guesses"). Directions, style
 * properties, class names and variable names are all allowlists, and the same
 * lists build the schema and the validator so the two cannot drift.
 *
 * Every tool reads deck state INSIDE `execute`. Registration happens before
 * React commits, so anything captured at install time is an empty deck.
 */
import { harvestDeck, harvestSlide } from "../harvest/index.js";
import { locate } from "../harvest/locate.js";
import { provenanceOf } from "../harvest/provenance.js";
import {
  outline,
  outlineText,
  position,
  slideText,
  slideView,
} from "../harvest/views.js";
import {
  CSS_VARS,
  MAX_TEXT,
  setStyle,
  setText,
  setVariable,
  STYLE_PROPS,
  TOGGLE_CLASSES,
  toggleClass,
  resetEdits,
  undoEdit,
} from "../edit/apply.js";
import { summary, withEdits } from "../edit/patches.js";
import { start as startWatchdog } from "../edit/watchdog.js";
import { nav } from "../nav.js";
import { echo, resolveTarget } from "./target.js";

/**
 * EVERY RESULT CARRIES BOTH A SENTENCE AND ITS DATA.
 *
 * A tool result has two readers with opposite needs. A model reads the text
 * blocks and wants prose. Whatever chains one call into the next -- an agent's
 * code, a side panel, a script -- needs the ids, and should not have to recover
 * them with a regex from "6.9 — takeaway: A full agent workflow…".
 *
 * That was the shape until now, and it made the seam between two tools a parsing
 * problem: `find_node` handed back three lines of prose and `edit_node` wanted an
 * id. Every consumer would have written the same brittle extractor, and a
 * mis-parse is silent -- it edits the wrong node rather than failing.
 *
 * So: `structuredContent` beside the text, and an `outputSchema` on the tool so a
 * host knows the shape without guessing. Hosts that do not support it ignore the
 * field and still get readable prose with the ids in it; hosts that do get data
 * nobody has to parse.
 *
 * ONE text block, not one per line. Several blocks read as several messages, and
 * a list is one message.
 */
const text = (s) => ({ type: "text", text: s });

const ok = (lines, structured) => {
  const said = (Array.isArray(lines) ? lines : [lines])
    .filter(Boolean)
    .join("\n");
  const result = { content: [text(said)] };
  if (structured) result.structuredContent = structured;
  return result;
};

/**
 * A refusal, which still carries its data.
 *
 * Candidates on an ambiguity are the whole point of refusing rather than
 * guessing -- so they belong in `structuredContent` too, or the caller is back to
 * parsing prose at precisely the moment it needs to be precise.
 */
const fail = (message, structured) => {
  const result = { isError: true, content: [text(message)] };
  if (structured) result.structuredContent = structured;
  return result;
};

/** One node as data. Explicit fields, so the non-enumerable fiber cannot leak. */
export const nodeData = (node) => ({
  id: node.id,
  slide: node.slide,
  ordinal: node.ordinal,
  role: node.role,
  roleOrdinal: node.roleOrdinal,
  depth: node.depth,
  text: node.text,
});

/** The shape of a node, for every `outputSchema` that returns one. */
const NODE_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "The address, e.g. '9.3'. Pass this to any tool taking a target.",
    },
    slide: { type: "integer" },
    ordinal: {
      type: "integer",
      description: "Position among all addressable nodes on the slide.",
    },
    role: { type: "string", description: "title, bullet, takeaway, code, …" },
    roleOrdinal: {
      type: "integer",
      description: "Position among same-role nodes at the same depth.",
    },
    depth: {
      type: "integer",
      description:
        "List nesting. 0 outside a list, 1 a bullet, 2 a sub-bullet.",
    },
    text: { type: "string" },
  },
  required: ["id", "slide", "role", "text"],
};

const NODES_SCHEMA = { type: "array", items: NODE_SCHEMA };

const NO_DECK =
  "The deck is not reachable right now — it may be in overview or presenter mode. Try again, or press Escape.";

/**
 * The slide a READ should act on: the one asked for, or the one on screen.
 *
 * READS REFUSE AN IMPOSSIBLE SLIDE; NAVIGATION CLAMPS. The asymmetry is
 * deliberate and it is the same risk model as the `?mcp` gate: "go to slide 99"
 * plausibly means "go to the end" and costs a keypress to undo, while "find X on
 * slide 99" has no sensible reading and answering it from some other slide is a
 * confidently wrong answer nobody has a reason to double-check.
 *
 * SLIDE 0 IS THE ONE WORTH NAMING. `activeView.slideIndex` really is 0-based
 * inside Spectacle while everything a person or an agent says about this deck is
 * 1-based, so passing 0 is a reasonable mistake rather than a nonsense one --
 * which is why the refusal states the range instead of only rejecting.
 *
 * This used to be `if (Number.isInteger(n) && n > 0) return n;` with a fallback
 * to the current slide, so `get_speaker_notes({ slide: 0 })` silently returned
 * the notes for whatever slide was on screen. Measured: asked for slide 0 while
 * on slide 9, got slide 9's notes, labelled "slide 9", with nothing to say the
 * request had been quietly rewritten.
 */
const readSlide = (asked) => {
  if (asked === undefined || asked === null || asked === "") {
    const current = position().slide;
    return current
      ? { ok: true, number: current }
      : { ok: false, message: NO_DECK };
  }

  const n = Number(asked);
  const count = nav.count() || 0;

  if (!Number.isInteger(n)) {
    return { ok: false, message: `"${asked}" is not a slide number.` };
  }
  if (n < 1 || (count && n > count)) {
    return {
      ok: false,
      message: `There is no slide ${n} — the deck has slides 1 to ${count || "?"}.`,
    };
  }
  return { ok: true, number: n };
};

/** One node, as a line a caller can read and act on. */
const line = (node) => `${node.id} — ${node.role}: ${node.text}`;

/** `slide`, as every read tool declares it. */
const SLIDE_PARAM = {
  type: "integer",
  minimum: 1,
  description:
    "Slide number, 1-based (the first slide is 1, not 0). Defaults to the slide on screen.",
};

// --- Read --------------------------------------------------------------------

export const READ_TOOLS = [
  {
    name: "get_current_slide",
    description:
      "Read the slide currently on screen: its number, title, and every addressable piece of text on it with a short id (like 9.3), what kind of thing it is (title, bullet, sub-bullet, takeaway, code), and its wording. Use this first when asked to change, summarise, or describe 'this slide'. The ids it returns are what the editing tools take.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        slide: { type: "integer" },
        count: { type: "integer", description: "Slides in the deck." },
        title: { type: ["string", "null"] },
        chapter: { type: ["integer", "null"] },
        nodes: NODES_SCHEMA,
      },
      required: ["slide", "count", "nodes"],
    },
    execute: async () => {
      const at = position();
      if (!at.slide) return fail(NO_DECK);
      const slide = slideView(at.slide);
      if (!slide)
        return fail(`Slide ${at.slide} has nothing addressable on it.`);

      // Through the edit overlay, so a caller that just changed something sees
      // its own change. The harvest reads fibers and an edit writes the DOM, so
      // without this the slide reports its authored wording and the edit looks
      // like it did nothing.
      const nodes = withEdits(slide.nodes);
      return ok(
        [`slide ${at.slide} of ${at.count}`, slideText({ ...slide, nodes })],
        {
          slide: at.slide,
          count: at.count,
          title: slide.title ?? null,
          chapter: slide.chapter ?? null,
          nodes: nodes.map(nodeData),
        },
      );
    },
  },
  {
    name: "get_deck_outline",
    description:
      "List every slide in the deck: number, title, chapter, and whether it carries a code example. Use this to find which slide covers a topic before navigating, or to answer questions about the deck's shape. It does not include slide body text — use search_deck for that.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              number: { type: "integer" },
              title: { type: ["string", "null"] },
              chapter: { type: ["integer", "null"] },
              kind: { type: "string" },
              code: { type: "array", items: { type: "string" } },
            },
            required: ["number"],
          },
        },
      },
      required: ["slides"],
    },
    execute: async () => {
      const slides = outline();
      return ok(outlineText(slides), { slides });
    },
  },
  {
    name: "find_node",
    description:
      "Find what on a slide matches a description, and get the ids that name it. Accepts either wording from the slide ('the WebMCP bullet', 'One API') or a position ('the second bullet', 'the heading', 'the last sub-bullet'). Returns every match — one id when the description fits one thing, several when it fits several, and the slide's contents when it fits nothing. Use it to answer 'what on this slide mentions X' as well as to get an id before editing. Defaults to the slide on screen.",
    inputSchema: {
      type: "object",
      properties: {
        phrase: {
          type: "string",
          description:
            "How a person would refer to it: quoted wording from the slide, or a position like 'the second bullet'.",
        },
        slide: SLIDE_PARAM,
      },
      required: ["phrase"],
    },
    outputSchema: {
      type: "object",
      properties: {
        matches: NODES_SCHEMA,
        slide: { type: "integer" },
        matched: {
          type: "string",
          // Mirrors `locate()`'s own `match` values exactly. It must: a value
          // the code can produce and the schema does not list is a result a
          // strict host is entitled to reject, and "ambiguous" -- the whole
          // multiple-matches case -- was missing from the first draft of this.
          enum: ["text", "ordinal", "role", "ambiguous", "none"],
          description:
            "How it resolved. 'text' is strongest — the phrase is in the node's wording. 'ambiguous' means several matched equally; pick one by id.",
        },
      },
      required: ["matches", "slide", "matched"],
    },
    // FINDING SEVERAL THINGS IS A SUCCESSFUL FIND, and this deliberately does
    // NOT go through `resolveTarget` for that reason.
    //
    // Ambiguity is only dangerous for a tool that ACTS: `edit_node` given three
    // candidates would change the wrong one, so it refuses. This one reports,
    // and reporting three matches is the correct and complete answer rather than
    // a failure. It used to return `isError` with the candidates attached, which
    // told the host and the caller that a search had failed when it had
    // succeeded -- and left "what on this slide mentions the browser?" with no
    // expressible answer at all.
    //
    // `isError` here is reserved for what it means everywhere else: the request
    // could not be carried out. A bad slide number qualifies; finding nothing
    // does not, and comes back as an empty result with the slide's roster, which
    // is the useful reply to a miss.
    execute: async ({ phrase, slide }) => {
      const where = readSlide(slide);
      if (!where.ok) return fail(where.message);

      const found = locate(phrase, { slide: where.number });

      if (found.match === "none") {
        const roster = found.nodes.slice(0, 12);
        return ok(
          [
            found.note
              ? `Nothing matches "${phrase}" — ${found.note}.`
              : `Nothing on slide ${where.number} matches "${phrase}". What is there:`,
            ...roster.map(line),
          ],
          // `matches` is empty and the roster rides alongside it, so a caller can
          // tell "no result" from "here are twelve results" without counting.
          {
            matches: [],
            slide: where.number,
            matched: "none",
            slideNodes: roster.map(nodeData),
          },
        );
      }

      const many = found.nodes.length > 1;
      return ok(
        many
          ? [
              `${found.nodes.length} matches for "${phrase}" on slide ${where.number} — use an id to act on one:`,
              ...found.nodes.map(line),
            ]
          : [found.nodes[0].id, echo(found.nodes[0].id)],
        {
          matches: found.nodes.map(nodeData),
          slide: where.number,
          matched: found.match,
        },
      );
    },
  },
  {
    name: "where_is_node",
    description:
      "Say where a piece of slide text comes from in the deck's source, so it can be edited permanently rather than only on screen. Returns an exact file and field when the text lives in a data module, a string to search the source for when it does not, or an honest 'composed at runtime' when the text exists as a literal nowhere. Use this when asked where something lives or how to change it for real.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "A node id like '9.3', or a description like 'the second bullet'.",
        },
      },
      required: ["target"],
    },
    outputSchema: {
      type: "object",
      properties: {
        node: NODE_SCHEMA,
        provenance: {
          type: "object",
          properties: {
            match: {
              type: "string",
              enum: [
                "data",
                "exact",
                "partial",
                "ambiguous",
                "file",
                "too-short",
                "not-found",
                "unknown",
              ],
              description: "How confident the pointer is. Read this first.",
            },
            kind: { type: "string" },
            pointer: {
              type: ["string", "null"],
              description: "An exact file and field, when there is one.",
            },
            search: {
              type: ["string", "null"],
              description: "What to grep for. Null when nothing will find it.",
            },
            file: { type: ["string", "null"] },
            count: { type: ["integer", "null"] },
          },
          required: ["match", "kind"],
        },
      },
      required: ["node", "provenance"],
    },
    execute: async ({ target }) => {
      const found = resolveTarget(target);
      if (!found.ok) return found.result;

      const { node } = found;
      const prov = await provenanceOf(node, harvestSlide(node.slide));
      return ok(
        [
          echo(node.id),
          prov.pointer
            ? `source: ${prov.pointer}`
            : prov.search
              ? `search index.html for: ${prov.search}`
              : "composed at runtime — this exact string is not in the source",
          `confidence: ${prov.match}${prov.count > 1 ? ` (${prov.count} matches)` : ""}`,
        ],
        { node: nodeData(node), provenance: prov },
      );
    },
  },
  {
    name: "search_deck",
    description:
      "Search the text of every slide in the deck and return the slides and node ids that match. Use this to find where a word or phrase appears across the whole talk — for example every slide mentioning WebMCP, or every remaining TODO.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for." },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        matches: NODES_SCHEMA,
        total: {
          type: "integer",
          description:
            "Matches found. May exceed `matches.length` — see `truncated`.",
        },
        truncated: { type: "boolean" },
      },
      required: ["matches", "total", "truncated"],
    },
    execute: async ({ query }) => {
      const needle = String(query ?? "")
        .trim()
        .toLowerCase();
      if (needle.length < 2) return fail("Give me at least two characters.");

      const hits = harvestDeck()
        .slides.flatMap((slide) => slide.nodes)
        .filter((node) => node.text.toLowerCase().includes(needle));

      if (!hits.length) {
        return ok(`Nothing in the deck matches "${query}".`, {
          matches: [],
          total: 0,
          truncated: false,
        });
      }

      // CAPPED, AND IT SAYS SO. A silent cut reads as "that is all of them",
      // which is the whole deck's worth of TODOs looking like forty.
      const shown = hits.slice(0, 40);
      return ok(
        [
          `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}":`,
          ...shown.map(
            (n) => `${n.id} (slide ${n.slide}, ${n.role}): ${n.text}`,
          ),
          hits.length > shown.length
            ? `…and ${hits.length - shown.length} more.`
            : null,
        ],
        {
          matches: shown.map(nodeData),
          total: hits.length,
          truncated: hits.length > shown.length,
        },
      );
    },
  },
  {
    name: "get_speaker_notes",
    description:
      "Read the presenter's private notes for a slide — what they planned to say, plus timings and any TODOs. These are not shown to the audience. Defaults to the slide on screen. 27 of the 35 slides have notes; the chapter dividers do not.",
    inputSchema: {
      type: "object",
      properties: {
        slide: SLIDE_PARAM,
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        slide: { type: "integer" },
        notes: { type: ["string", "null"] },
      },
      required: ["slide", "notes"],
    },
    execute: async ({ slide }) => {
      const where = readSlide(slide);
      if (!where.ok) return fail(where.message);

      const harvested = harvestSlide(where.number);
      if (!harvested) return fail(`There is no slide ${where.number}.`);

      return harvested.notes
        ? ok([`Speaker notes, slide ${where.number}:`, harvested.notes], {
            slide: where.number,
            notes: harvested.notes,
          })
        : ok(`Slide ${where.number} has no speaker notes.`, {
            slide: where.number,
            notes: null,
          });
    },
  },
];

/** What every navigation reports: where it went, measured after it landed. */
const POSITION_SCHEMA = {
  type: "object",
  properties: {
    slide: { type: "integer", description: "Where the deck is now, 1-based." },
    from: { type: "integer", description: "Where it was before this call." },
    count: { type: "integer" },
    title: { type: ["string", "null"] },
    moved: { type: "boolean", description: "False at either end of the deck." },
    clamped: { type: "boolean" },
  },
  required: ["slide", "from", "count", "moved"],
};

// --- Navigate ----------------------------------------------------------------

/** Where `move_deck` can go, and what each one calls. */
const MOVES = {
  next_step: { fn: () => nav.next(), says: "forward one step" },
  previous_step: { fn: () => nav.prev(), says: "back one step" },
  next: { fn: () => nav.nextSlide(), says: "to the next slide" },
  previous: { fn: () => nav.prevSlide(), says: "to the previous slide" },
  first: { fn: () => nav.first(), says: "to the first slide" },
  last: { fn: () => nav.last(), says: "to the last slide" },
};

export const NAV_TOOLS = [
  {
    name: "go_to_slide",
    description:
      "Jump to a specific slide by its number, or to the first slide of a chapter. Slide numbers are 1-based and the deck has 35. Out-of-range numbers are clamped rather than refused. To move relative to where the deck is now — next, previous, last — use move_deck instead.",
    inputSchema: {
      type: "object",
      properties: {
        slide: { type: "integer", description: "Slide number, 1-based." },
        chapter: {
          type: "integer",
          description:
            "Chapter number. Goes to that chapter's first slide. Ignored when 'slide' is given.",
        },
      },
    },
    outputSchema: POSITION_SCHEMA,
    execute: async ({ slide, chapter }) => {
      let wanted = slide;

      if (wanted == null && chapter != null) {
        // Chapters come from the harvest rather than from a DOM sweep: every
        // slide already carries its chapter, parsed from the `ch-N` class.
        const first = outline().find((s) => s.chapter === Number(chapter));
        if (!first) return fail(`There is no chapter ${chapter}.`);
        wanted = first.number;
      }
      if (wanted == null) return fail("Give me a slide number or a chapter.");

      const move = await nav.toSlide(wanted);
      if (!move) return fail(NO_DECK);

      // Read back from the deck, never from the argument: `to` is where it
      // actually is now, which is the only number worth putting in a receipt.
      const slideAt = harvestSlide(move.to);
      return ok(
        [
          `Slide ${move.to} of ${nav.count()}${slideAt?.title ? ` — ${slideAt.title}` : ""}`,
          move.clamped
            ? `(${wanted} is out of range, so this is as far as it goes.)`
            : null,
        ],
        {
          slide: move.to,
          from: move.from,
          count: nav.count(),
          title: slideAt?.title ?? null,
          moved: move.moved,
          clamped: move.clamped,
        },
      );
    },
  },
  {
    name: "move_deck",
    description:
      "Move the deck relative to where it is now. 'next' and 'previous' change slide; 'next_step' and 'previous_step' advance one reveal within a slide that has them, moving to the neighbouring slide when there are none left. At either end the deck stays put.",
    inputSchema: {
      type: "object",
      properties: {
        where: {
          type: "string",
          enum: Object.keys(MOVES),
          description: "Which way to move.",
        },
      },
      required: ["where"],
    },
    outputSchema: POSITION_SCHEMA,
    execute: async ({ where }) => {
      const move = MOVES[where];
      if (!move) return fail(`Can't move "${where}".`);

      const result = await move.fn();
      if (!result) return fail(NO_DECK);

      const slideAt = harvestSlide(result.to);
      const at = {
        slide: result.to,
        from: result.from,
        count: nav.count(),
        title: slideAt?.title ?? null,
        moved: result.moved,
        clamped: false,
      };

      // A no-op at either end is a real answer, not a failure: Spectacle clamps,
      // so "next" on slide 35 legitimately does nothing and saying so is more
      // use to the caller than either "done" or "couldn't".
      if (!result.moved) {
        return ok(
          `Already at the end of the deck that way — still on slide ${result.to} of ${nav.count()}.`,
          at,
        );
      }

      return ok(
        `Moved ${move.says}: slide ${result.from} → ${result.to} of ${nav.count()}${
          slideAt?.title ? ` — ${slideAt.title}` : ""
        }`,
        at,
      );
    },
  },
];

// --- Mutate ------------------------------------------------------------------

/**
 * Run a mutation against a target, and report what actually happened.
 *
 * Every editing tool has the same three beats -- resolve, apply, receipt -- and
 * the receipt always leads with the echo-back. That is the recovered discipline:
 * a receipt describes what was applied, never what was asked for, because three
 * separate turns once produced "Done." for a change nothing on the slide
 * reflected and "a receipt reporting a change that did not happen is worse than
 * a refusal, because the presenter stops looking."
 */
const mutate = (target, run) => {
  const found = resolveTarget(target);
  if (!found.ok) return found.result;

  const result = run(found.node);
  if (!result.ok) return fail(result.message);

  // The node it landed on, so a caller can chain another change to the same
  // thing without re-resolving the phrase -- and so "which one did it pick?" has
  // an answer that is not in prose.
  return ok([result.label, result.note], {
    applied: true,
    node: nodeData(found.node),
    edits: summary(),
  });
};

/** What every editing tool reports. */
const EDIT_SCHEMA = {
  type: "object",
  properties: {
    applied: { type: "boolean" },
    node: NODE_SCHEMA,
    edits: {
      type: "object",
      description: "The edit log after this change.",
      properties: {
        count: { type: "integer" },
        canUndo: { type: "boolean" },
        canRedo: { type: "boolean" },
        labels: { type: "array", items: { type: "string" } },
        stale: { type: "array", items: { type: "string" } },
      },
    },
  },
  required: ["applied"],
};

/**
 * The editing tools, only built when `?mcp` says so.
 *
 * A function rather than a constant because the edit layer should not even be
 * constructed on a normal load: having nothing to register is a stronger
 * guarantee than registering nothing.
 */
export const installEditTools = () => {
  // Only once anything can actually edit: an observer on the slide portal costs
  // nothing on a read-only load, and starting it there would be a moving part
  // with no job.
  startWatchdog();

  return EDIT_TOOLS;
};

const EDIT_TOOLS = [
  {
    name: "edit_node",
    description:
      "Change the wording of one piece of text on a slide. Identify it either by id (from get_current_slide or find_node) or by describing it — 'the second bullet', 'the heading'. If the description matches more than one thing this refuses and lists the candidates rather than guessing. Changes are live-only: they affect the running deck, not the source files. Use where_is_node to find the source, and undo_edit or reset_edits to put it back.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "A node id like '9.3', or a description like 'the second bullet'.",
        },
        text: {
          type: "string",
          description: `The new wording. Keep it under ${MAX_TEXT} characters or it overflows the slide.`,
        },
      },
      required: ["target", "text"],
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ target, text: value }) =>
      mutate(target, (node) => setText(node.id, value)),
  },
  {
    name: "style_node",
    description:
      "Restyle one piece of text on a slide — its colour, size, weight, alignment and so on. Relative sizes like 'bigger' are resolved against the element's real size before being applied, and the receipt reports the value the slide actually got. A value the browser will not accept is refused rather than silently dropped.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "A node id like '9.3', or a description like 'the heading'.",
        },
        property: {
          type: "string",
          enum: STYLE_PROPS,
          description: "Which CSS property to set.",
        },
        value: {
          type: "string",
          description:
            "The value, e.g. 'red', '48px', 'bold'. For font-size, 'bigger' and 'smaller' also work.",
        },
      },
      required: ["target", "property", "value"],
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ target, property, value }) =>
      mutate(target, (node) => setStyle(node.id, property, value)),
  },
  {
    name: "toggle_node_class",
    description:
      "Add or remove one of the deck's own styling classes on a piece of text — emphasis, compact takeaways, dense cards, or fixing a heading's colour against the chapter treatment.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "A node id, or a description." },
        class_name: {
          type: "string",
          enum: TOGGLE_CLASSES,
          description: "Which class.",
        },
        on: {
          type: "boolean",
          description: "True to add it, false to remove it.",
        },
      },
      required: ["target", "class_name", "on"],
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ target, class_name, on }) =>
      mutate(target, (node) => toggleClass(node.id, class_name, on)),
  },
  {
    name: "set_deck_variable",
    description:
      "Change one of the deck's theme colours, either for the current chapter or across the whole deck. These drive the accent colour, surfaces and hairlines that every slide is built from, so one change is visible everywhere.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: CSS_VARS,
          description: "Which theme variable.",
        },
        value: {
          type: "string",
          description: "A CSS colour, e.g. 'orange' or '#ff8800'.",
        },
        scope: {
          type: "string",
          enum: ["deck", "chapter"],
          description:
            "'deck' changes it everywhere; 'chapter' only for the chapter the deck is on.",
        },
      },
      required: ["name", "value", "scope"],
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ name, value, scope }) => {
      const at = position();
      const chapter = at.slide ? harvestSlide(at.slide)?.chapter : null;
      const result = setVariable(name, value, scope, chapter);
      return result.ok
        ? ok([result.label, result.note], {
            applied: true,
            edits: summary(),
          })
        : fail(result.message);
    },
  },
  {
    name: "undo_edit",
    description:
      "Undo the most recent change to the deck, one at a time. Only undoes edits — navigation is not an edit, so this never moves the deck.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: EDIT_SCHEMA,
    execute: async () => {
      const result = undoEdit();
      return result.ok
        ? ok(result.label, { applied: true, edits: summary() })
        : fail(result.message, { applied: false, edits: summary() });
    },
  },
  {
    name: "reset_edits",
    description:
      "Undo every change at once and return the deck to exactly how it shipped. Use this to clean up after experimenting.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: EDIT_SCHEMA,
    execute: async () =>
      ok(resetEdits().label, { applied: true, edits: summary() }),
  },
];
