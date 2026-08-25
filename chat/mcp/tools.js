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
 * EIGHT TOOLS, DOWN FROM FOURTEEN, and the count is the design rather than
 * tidying. The consumer this has to work for is a 2B on-device model choosing a
 * tool and filling its arguments in one shot, with no grammar-constrained
 * decoding to keep it inside the lines (`docs/chat-handoff.md` §10). Every tool
 * that overlaps another is a coin flip that model has to win. So the pairs that
 * differed only in scope were merged into one tool with a scope argument:
 *
 *   get_current_slide + get_speaker_notes   -> get_slide({ slide, notes })
 *   find_node + search_deck                 -> find_nodes({ query, slide, scope })
 *   go_to_slide + move_deck                 -> go_to_slide({ slide, chapter, move })
 *   undo_edit + reset_edits                 -> undo_edits({ scope, slide })
 *
 * `toggle_node_class` went away because `style_node` does its useful half, and
 * `where_is_node` because pointing at source is a thing you do in an editor, not
 * mid-talk -- it lives on as `deckDump.where()` for the console.
 *
 * DESCRIPTIONS ARE PROMPT ENGINEERING, which is the deck's own line about this
 * exact API (slide 10's notes: "Descriptions are prompt engineering. The model
 * reads them to decide"). They are written for an agent choosing between eight
 * tools, not for a reader who already knows what the deck is.
 *
 * ENUMS WHERE THE ANSWER IS CLOSED, which is the deck's other line ("`sortBy` is
 * an enum: constrain the agent, don't hope it guesses"). Directions, style
 * properties, scopes and variable names are all allowlists, and the same lists
 * build the schema and the validator so the two cannot drift.
 *
 * A PHRASE IS A FIRST-CLASS TARGET, and that is what keeps the common case to
 * one call. "Make the second bullet yellow" does not need a find-then-edit round
 * trip, because `resolveTarget` takes "the second bullet" directly -- see
 * `target.js`. Chaining is available when a phrase is ambiguous; it is not the
 * default path.
 *
 * Every tool reads deck state INSIDE `execute`. Registration happens before
 * React commits, so anything captured at install time is an empty deck.
 */
import { harvestSlide } from "../harvest/index.js";
import { locate } from "../harvest/locate.js";
import {
  nodeIndex,
  outline,
  outlineText,
  position,
  slideText,
  slideView,
} from "../harvest/views.js";
import {
  CSS_VARS,
  MAX_TEXT,
  replaceText,
  resetEdits,
  resetSlide,
  setStyle,
  setText,
  setVariable,
  STYLE_PROPS,
  undoEdit,
} from "../edit/apply.js";
import { summary, withEdits } from "../edit/patches.js";
import { start as startWatchdog } from "../edit/watchdog.js";
import { nav } from "../nav.js";
import { echo, resolveTarget } from "./target.js";
import { line, nodeData } from "./shape.js";

/**
 * EVERY RESULT CARRIES BOTH A SENTENCE AND ITS DATA.
 *
 * A tool result has two readers with opposite needs: a model reads the text blocks and
 * wants prose, while whatever chains one call into the next needs the ids and should not
 * have to recover them with a regex from "6.9 — takeaway: A full agent workflow…". Without
 * `structuredContent` the seam between `find_nodes` and `edit_text` is a parsing problem,
 * and a mis-parse is silent -- it edits the wrong node rather than failing.
 *
 * Hosts that ignore `structuredContent` still get readable prose with the ids in it.
 *
 * ONE text block, not one per line: several blocks read as several messages.
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

/**
 * What a refusal puts in `structuredContent`, declared for every tool that can refuse.
 *
 * `target.js`'s `refuse()` returns `{ candidates }` on an ambiguous or missed phrase, and
 * that rides on the same `structuredContent` channel as a success. Undeclared, it is
 * exactly the drift `mcp/index.js` warns about: a value the code emits and the schema does
 * not list is a value a strict host is entitled to reject.
 *
 * The `required` list on each schema still describes a SUCCESS -- a refusal is an
 * `isError: true` result, which is not the success shape and is not validated as one.
 */
const CANDIDATES_SCHEMA = {
  ...NODES_SCHEMA,
  description:
    "Present only on a refusal: the nodes a description matched, to pick one id from.",
};

/** The edit log, reported everywhere it could be useful rather than by its own tool. */
const EDITS_SCHEMA = {
  type: "object",
  description:
    "The edit log. `count` is edits, not patches — one find-and-replace across a slide is one edit and one undo.",
  properties: {
    count: { type: "integer" },
    canUndo: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    stale: {
      type: "array",
      items: { type: "string" },
      description:
        "Edits whose target stopped resolving, so they no longer show.",
    },
  },
};

const NO_DECK =
  "The deck is not reachable right now — it may be in overview or presenter mode. Try again, or press Escape.";

/**
 * The slide a READ should act on: the one asked for, or the one on screen.
 *
 * READS REFUSE AN IMPOSSIBLE SLIDE; NAVIGATION CLAMPS. The asymmetry is
 * deliberate: "go to slide 99" plausibly means "go to the end" and costs a
 * keypress to undo, while "find X on slide 99" has no sensible reading and
 * answering it from some other slide is a confidently wrong answer nobody has a
 * reason to double-check.
 *
 * SLIDE 0 IS WORTH NAMING. `activeView.slideIndex` is 0-based inside Spectacle while
 * everything a person or agent says about this deck is 1-based, so passing 0 is a
 * reasonable mistake -- hence a refusal that states the range rather than only rejecting.
 *
 * An out-of-range ask must NOT fall back to the current slide: that returns slide 9's
 * notes labelled "slide 9" with nothing to say the request was rewritten.
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

/** `slide`, as every tool that takes one declares it. */
const SLIDE_PARAM = {
  type: "integer",
  minimum: 1,
  description:
    "Slide number, 1-based (the first slide is 1, not 0). Defaults to the slide on screen.",
};

/** `true` from a checkbox, a string, or a model that wrote it either way. */
const truthy = (value) =>
  value === true || value === "true" || value === 1 || value === "1";

// --- Read --------------------------------------------------------------------

export const READ_TOOLS = [
  {
    name: "get_slide",
    description:
      "Read one slide: its number, title, and every addressable piece of text on it with a short id (like 9.3), what kind of thing it is (title, bullet, sub-bullet, takeaway, code), and its wording. Defaults to the slide on screen. Use this first when asked to change, summarise, or describe 'this slide'. The ids it returns are what the editing tools take. Set notes to true to also read the presenter's private speaker notes, which are not shown to the audience.",
    inputSchema: {
      type: "object",
      properties: {
        slide: SLIDE_PARAM,
        notes: {
          type: "boolean",
          description:
            "Also return the presenter's private speaker notes. Most slides have them; the chapter dividers do not.",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        slide: { type: "integer" },
        count: { type: "integer", description: "Slides in the deck." },
        title: { type: ["string", "null"] },
        chapter: { type: ["integer", "null"] },
        nodes: NODES_SCHEMA,
        notes: {
          type: ["string", "null"],
          description:
            "Null unless `notes` was requested, or the slide has none.",
        },
        edits: EDITS_SCHEMA,
      },
      required: ["slide", "count", "nodes"],
    },
    execute: async ({ slide, notes }) => {
      const where = readSlide(slide);
      if (!where.ok) return fail(where.message);

      const view = slideView(where.number);
      if (!view)
        return fail(`Slide ${where.number} has nothing addressable on it.`);

      // Through the edit overlay, so a caller that just changed something sees
      // its own change. The harvest reads fibers and an edit writes the DOM, so
      // without this the slide reports its authored wording and the edit looks
      // like it did nothing.
      const nodes = withEdits(view.nodes);
      const wantNotes = truthy(notes);
      const count = position().count ?? nav.count() ?? 0;

      return ok(
        [
          `slide ${where.number} of ${count}`,
          slideText({ ...view, nodes }),
          wantNotes
            ? view.notes
              ? `Speaker notes:\n${view.notes}`
              : "This slide has no speaker notes."
            : null,
        ],
        {
          slide: where.number,
          count,
          title: view.title ?? null,
          chapter: view.chapter ?? null,
          nodes: nodes.map(nodeData),
          notes: wantNotes ? (view.notes ?? null) : null,
          edits: summary(),
        },
      );
    },
  },
  {
    name: "get_deck_outline",
    description:
      "List every slide in the deck: number, title, chapter, and whether it carries a code example. Use this to find which slide covers a topic before navigating, or to answer questions about the deck's shape. It does not include slide body text — use find_nodes with scope 'deck' for that.",
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
    name: "find_nodes",
    description:
      "Find what matches a description and get the ids that name it. On one slide (the default) it accepts either wording from the slide ('the WebMCP bullet', 'One API') or a position ('the second bullet', 'the heading', 'the last sub-bullet'). With scope set to 'deck' it searches the text of every slide instead — use that for 'which slide covers X' or 'every slide that still says TODO'. Returns every match: one id when the description fits one thing, several when it fits several, and the slide's contents when it fits nothing.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "How a person would refer to it: quoted wording, or a position like 'the second bullet' (positions only work on a single slide).",
        },
        slide: SLIDE_PARAM,
        scope: {
          type: "string",
          enum: ["slide", "deck"],
          description:
            "'slide' searches one slide and understands positions. 'deck' searches every slide's text and ignores `slide`. Defaults to 'slide'.",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        matches: NODES_SCHEMA,
        scope: { type: "string", enum: ["slide", "deck"] },
        slide: {
          type: ["integer", "null"],
          description: "The slide searched. Null when the scope was the deck.",
        },
        matched: {
          // Mirrors `locate()`'s `match` values exactly, and must: a value the code can
          // produce and the schema does not list is one a strict host may reject.
          type: "string",
          enum: ["text", "ordinal", "role", "ambiguous", "none"],
          description:
            "How it resolved. 'text' is strongest — the phrase is in the node's wording. 'ambiguous' means several matched equally; pick one by id.",
        },
        total: {
          type: "integer",
          description:
            "Matches found. May exceed `matches.length` — see `truncated`.",
        },
        truncated: { type: "boolean" },
        // Emitted on `matched: "none"` at slide scope only, and the useful half of
        // that answer -- the roster turns "no" into a menu.
        slideNodes: {
          ...NODES_SCHEMA,
          description:
            "Present only when nothing matched on a slide: everything addressable there, to pick from.",
        },
      },
      required: ["matches", "scope", "slide", "matched", "total", "truncated"],
    },
    // FINDING SEVERAL THINGS IS A SUCCESSFUL FIND, and this deliberately does
    // NOT go through `resolveTarget` for that reason.
    //
    // Ambiguity is only dangerous for a tool that ACTS: `edit_text` given three
    // candidates would change the wrong one, so it refuses. This one reports, and three
    // matches is the correct and complete answer rather than a failure -- returning
    // `isError` here leaves "what on this slide mentions the browser?" with no
    // expressible answer at all.
    //
    // `isError` here is reserved for what it means everywhere else: the request
    // could not be carried out. A bad slide number qualifies; finding nothing
    // does not, and comes back as an empty result with the slide's roster.
    execute: async ({ query, slide, scope }) => {
      const said = String(query ?? "").trim();
      if (said.length < 2) return fail("Give me at least two characters.");

      if (scope === "deck") {
        const needle = said.toLowerCase();
        const hits = nodeIndex().filter((node) =>
          node.text.toLowerCase().includes(needle),
        );

        if (!hits.length) {
          return ok(`Nothing in the deck matches "${said}".`, {
            matches: [],
            scope: "deck",
            slide: null,
            matched: "none",
            total: 0,
            truncated: false,
          });
        }

        // CAPPED, AND IT SAYS SO. A silent cut reads as "that is all of them",
        // which is the whole deck's worth of TODOs looking like forty.
        const shown = hits.slice(0, 40);
        return ok(
          [
            `${hits.length} match${hits.length === 1 ? "" : "es"} for "${said}" across the deck:`,
            ...shown.map(
              (n) => `${n.id} (slide ${n.slide}, ${n.role}): ${n.text}`,
            ),
            hits.length > shown.length
              ? `…and ${hits.length - shown.length} more.`
              : null,
          ],
          {
            matches: shown.map(nodeData),
            scope: "deck",
            slide: null,
            matched: "text",
            total: hits.length,
            truncated: hits.length > shown.length,
          },
        );
      }

      const where = readSlide(slide);
      if (!where.ok) return fail(where.message);

      const found = locate(said, { slide: where.number });

      if (found.match === "none") {
        const roster = found.nodes.slice(0, 12);
        return ok(
          [
            found.note
              ? `Nothing matches "${said}" — ${found.note}.`
              : `Nothing on slide ${where.number} matches "${said}". What is there:`,
            ...roster.map(line),
          ],
          // `matches` is empty and the roster rides alongside it, so a caller can
          // tell "no result" from "here are twelve results" without counting.
          {
            matches: [],
            scope: "slide",
            slide: where.number,
            matched: "none",
            total: 0,
            truncated: false,
            slideNodes: roster.map(nodeData),
          },
        );
      }

      const many = found.nodes.length > 1;
      return ok(
        many
          ? [
              `${found.nodes.length} matches for "${said}" on slide ${where.number} — use an id to act on one:`,
              ...found.nodes.map(line),
            ]
          : [found.nodes[0].id, echo(found.nodes[0].id)],
        {
          matches: found.nodes.map(nodeData),
          scope: "slide",
          slide: where.number,
          matched: found.match,
          total: found.nodes.length,
          truncated: false,
        },
      );
    },
  },
];

// --- Navigate ----------------------------------------------------------------

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

/** Where a relative `move` can go, and what each one calls. */
const MOVES = {
  next_step: { fn: () => nav.next(), says: "forward one step" },
  previous_step: { fn: () => nav.prev(), says: "back one step" },
  next: { fn: () => nav.nextSlide(), says: "to the next slide" },
  previous: { fn: () => nav.prevSlide(), says: "to the previous slide" },
  first: { fn: () => nav.first(), says: "to the first slide" },
  last: { fn: () => nav.last(), says: "to the last slide" },
};

/** The receipt every navigation shares, read back from the deck rather than the argument. */
const landed = (result, said, clamped) => {
  const slideAt = harvestSlide(result.to);
  const at = {
    slide: result.to,
    from: result.from,
    count: nav.count(),
    title: slideAt?.title ?? null,
    moved: result.moved,
    clamped: !!clamped,
  };

  // A no-op at either end is a real answer, not a failure: Spectacle clamps, so
  // "next" on the last slide legitimately does nothing and saying so is more use
  // to the caller than either "done" or "couldn't".
  if (!result.moved && !clamped) {
    return ok(
      `Already at the end of the deck that way — still on slide ${result.to} of ${at.count}.`,
      at,
    );
  }

  return ok(
    [
      `${said}: slide ${result.to} of ${at.count}${slideAt?.title ? ` — ${slideAt.title}` : ""}`,
      clamped
        ? `(${clamped} is out of range, so this is as far as it goes.)`
        : null,
    ],
    at,
  );
};

export const NAV_TOOLS = [
  {
    name: "go_to_slide",
    description:
      // No slide count in this string. `get_slide` and `get_deck_outline` both
      // report the real one, live, which is where an agent should read it from.
      "Move the deck. Give `slide` to jump to a slide number (1-based), `chapter` to jump to a chapter's first slide, or `move` to go somewhere relative to where the deck is now — next, previous, first, last, or one reveal forward or back within a slide that has them. Out-of-range slide numbers are clamped rather than refused, and at either end of the deck a relative move stays put.",
    inputSchema: {
      type: "object",
      properties: {
        slide: { type: "integer", description: "Slide number, 1-based." },
        chapter: {
          type: "integer",
          description:
            "Chapter number. Goes to that chapter's first slide. Ignored when `slide` is given.",
        },
        move: {
          type: "string",
          enum: Object.keys(MOVES),
          description:
            "Where to move, relative to now. Ignored when `slide` or `chapter` is given.",
        },
      },
    },
    outputSchema: POSITION_SCHEMA,
    // PRECEDENCE IS DECLARED, NOT DISCOVERED: slide, then chapter, then move.
    // A model that fills in two of the three gets a defined answer rather than
    // whichever branch happened to be written first.
    execute: async ({ slide, chapter, move }) => {
      let wanted = slide;

      if (wanted == null && chapter != null) {
        // Chapters come from the harvest rather than from a DOM sweep: every
        // slide already carries its chapter, parsed from the `ch-N` class.
        const first = outline().find((s) => s.chapter === Number(chapter));
        if (!first) return fail(`There is no chapter ${chapter}.`);
        wanted = first.number;
      }

      if (wanted != null) {
        const result = await nav.toSlide(wanted);
        if (!result) return fail(NO_DECK);
        return landed(result, "Moved", result.clamped ? wanted : null);
      }

      if (!move) {
        return fail("Give me a slide number, a chapter, or a move.");
      }

      // `hasOwn`, not a truthiness check on the lookup. `MOVES["constructor"]`
      // finds Object.prototype's and passes `if (!spec)`, then throws on
      // `spec.fn` -- reported as a transport failure rather than as the
      // perfectly good "Can't move that" answer one line down.
      const spec = Object.hasOwn(MOVES, move) ? MOVES[move] : null;
      if (!spec) return fail(`Can't move "${move}".`);

      const result = await spec.fn();
      if (!result) return fail(NO_DECK);
      return landed(result, `Moved ${spec.says}`, null);
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
    candidates: CANDIDATES_SCHEMA,
    changed: {
      type: "array",
      description: "Present on a find-and-replace: every node it touched.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          hits: { type: "integer" },
          before: { type: "string" },
          after: { type: "string" },
        },
        required: ["id", "hits", "before", "after"],
      },
    },
    edits: EDITS_SCHEMA,
  },
  required: ["applied"],
};

/**
 * How many nodes a single deck-wide replace may touch.
 *
 * Deck scope is the one call in this file whose blast radius is the entire talk,
 * and the failure is not that it breaks -- undo puts it back in one call -- but
 * that it is unreviewable. Forty changed nodes reported as "done" is not
 * something a presenter can check before walking on stage. Above the cap it
 * refuses and says how many, which turns an unreviewable edit into a decision.
 */
const DECK_LIMIT = 25;

/**
 * The editing tools, and the watchdog they need.
 *
 * RETURNS THE WATCHDOG'S `stop` ALONGSIDE THE TOOLS, so `installTools()`'s teardown can
 * actually stop the `MutationObserver` and the bus subscription it starts.
 */
export const installEditTools = () => {
  const stop = startWatchdog();
  return { tools: EDIT_TOOLS, stop };
};

const EDIT_TOOLS = [
  {
    name: "edit_text",
    description:
      "Change wording on the deck. Give `target` and `text` to rewrite one piece of text completely — identify it by id (like 9.3) or by describing it ('the second bullet', 'the heading'). Give `find` and `text` to replace a phrase wherever it appears instead: within one node if `target` is set, across one slide if `slide` is set, or across the whole deck if neither is. Replacing a phrase is the right choice when the text has inline code or emphasis in it, because it changes only the words matched and leaves the markup alone. Changes are live-only: they affect the running deck, not the source files, and undo_edits puts them back.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "A node id like '9.3', or a description like 'the second bullet'. Omit to act on a whole slide or the whole deck.",
        },
        slide: {
          type: "integer",
          minimum: 1,
          description:
            "Restrict a find-and-replace to this slide, 1-based. You do not have to be on it. Ignored when `target` is given.",
        },
        find: {
          type: "string",
          description:
            "The phrase to replace, matched anywhere it appears and case-insensitively. Omit to replace a target's whole wording instead.",
        },
        text: {
          type: "string",
          description: `The new wording — the whole text when there is no \`find\`, otherwise what to put in its place. Keep a piece of text under ${MAX_TEXT} characters or it overflows the slide.`,
        },
      },
      required: ["text"],
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ target, slide, find, text: value }) => {
      if (value === undefined || value === null) {
        return fail("Give me the new text.");
      }
      const needle = String(find ?? "").trim();

      // Whole-node rewrite: a target, and nothing named to change inside it.
      if (target && !needle) {
        return mutate(target, (node) => setText(node.id, value));
      }

      if (!needle) {
        // THE ONE COMBINATION THAT MUST NEVER RUN. No target, no find, just
        // text: read literally that is "rewrite every node in the deck to this
        // same string", which nobody has ever meant and undo is a poor answer to.
        return fail(
          "Give me either a `target` to rewrite, or a `find` phrase to replace. With neither, this would rewrite every node in the deck to the same text.",
        );
      }

      let ids;
      let where;

      if (target) {
        const found = resolveTarget(target);
        if (!found.ok) return found.result;
        ids = [found.node.id];
        where = echo(found.node.id);
      } else if (slide !== undefined && slide !== null && slide !== "") {
        const at = readSlide(slide);
        if (!at.ok) return fail(at.message);
        ids = (slideView(at.number)?.nodes ?? []).map((node) => node.id);
        where = `slide ${at.number}`;
      } else {
        const all = nodeIndex();
        const needful = needle.toLowerCase();
        const hits = all.filter((node) =>
          node.text.toLowerCase().includes(needful),
        );
        if (hits.length > DECK_LIMIT) {
          return fail(
            `"${needle}" appears in ${hits.length} places across the deck, which is more than I will change in one go. Narrow it with a slide number, or a target.`,
          );
        }
        ids = all.map((node) => node.id);
        where = "the whole deck";
      }

      const result = replaceText(ids, needle, value);
      if (!result.ok) return fail(result.message);

      return ok([`${result.label} (${where})`, result.note], {
        applied: true,
        changed: result.nodes,
        edits: summary(),
      });
    },
  },
  {
    name: "style_node",
    description:
      "Restyle one piece of text on a slide — its colour, size, weight, alignment and so on. Identify it by id or by describing it. Relative sizes like 'bigger' are resolved against the element's real size before being applied, and the receipt reports the value the slide actually got. To hide something, set `display` to 'none' or `visibility` to 'hidden' — nothing is ever removed, so undo_edits brings it straight back. A value the browser will not accept is refused rather than silently dropped.",
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
            "The value, e.g. 'red', '48px', 'bold', 'underline', 'none'. For font-size, 'bigger' and 'smaller' also work.",
        },
      },
      required: ["target", "property", "value"],
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ target, property, value }) =>
      mutate(target, (node) => setStyle(node.id, property, value)),
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
        ? ok([result.label, result.note], { applied: true, edits: summary() })
        : fail(result.message);
    },
  },
  {
    name: "undo_edits",
    description:
      "Put changes back. 'last' undoes the most recent change — a find-and-replace counts as one change however many places it touched. 'slide' undoes everything changed on one slide and leaves the rest of the deck alone. 'all' returns the whole deck to exactly how it shipped. Navigation is not a change, so this never moves the deck.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["last", "slide", "all"],
          description: "How much to put back. Defaults to 'last'.",
        },
        slide: {
          type: "integer",
          minimum: 1,
          description:
            "Which slide to revert, 1-based. Only read when scope is 'slide'; defaults to the slide on screen.",
        },
      },
    },
    outputSchema: EDIT_SCHEMA,
    execute: async ({ scope, slide }) => {
      const how = scope || "last";

      if (how === "all") {
        return ok(resetEdits().label, { applied: true, edits: summary() });
      }

      if (how === "slide") {
        const where = readSlide(slide);
        if (!where.ok) return fail(where.message);
        const result = resetSlide(where.number);
        return result.ok
          ? ok(result.label, { applied: true, edits: summary() })
          : fail(result.message, { applied: false, edits: summary() });
      }

      const result = undoEdit();
      return result.ok
        ? ok(result.label, { applied: true, edits: summary() })
        : fail(result.message, { applied: false, edits: summary() });
    },
  },
];
