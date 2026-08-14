/**
 * One slide's fiber subtree, as Markdown.
 *
 * The successor to the `chat/deck-adapter.js` that `docs/chat-handoff.md` still
 * describes -- but NOT, unlike that file, the only deck-aware one. Deck
 * knowledge is split across two files, and anyone pointing this at a different
 * deck has to change both:
 *
 *   HERE          the class vocabulary below -- `TITLE_CLASSES`, `LABEL_CLASSES`,
 *                 `DECORATION_CLASSES`, `slide-subtitle`, `code-frame__name` --
 *                 plus two things the deck emits as raw HTML rather than as
 *                 components: `em()`'s `<span class="em">` and Phosphor's
 *                 `<i class="ph-*">`.
 *
 *   `index.js`    `/\bch-(\d)\b/` for the chapter a slide belongs to,
 *                 `.title-subtitle` for the deck's subtitle, and the `.slide` /
 *                 `.slide-title, .title-display, .divider__title` / code-pane
 *                 selectors the DOM fallback runs on. It also reads
 *                 `deck/chapters.js` and `deck/takeaways.js`, which are
 *                 structured data -- no DOM, no rendering assumptions.
 *
 * Naming both is the point. The selectors in `index.js` are easy to miss behind
 * a "rewrite one file" claim, and they fail at RUNTIME rather than at import,
 * so a port that trusted that claim would look like it worked.
 *
 * Everything else in this file and all of `fiber.js` is portable to any
 * Spectacle deck: component identity, the fiber walk, the `DeckContext` dedup,
 * and the `Notes` / `CodePane` / `Markdown` handling. Consolidating the
 * deck-specific half into one module is a real option, and the time to take it
 * is when `agent/prompt.js` finally consumes this -- a second consumer will say
 * whether the context layer needs deck vocabulary at all, which is not knowable
 * from here.
 *
 * IDENTITY, NEVER NAME. Spectacle arrives from jsdelivr as a minified `+esm`
 * bundle: `Notes` is `Br`, `Slide` is `Uo`, `Deck` is `ri`. Comparing
 * `fiber.type === Notes` works anyway because the import and the fiber hold the
 * same function reference. `fiber.type.name` would match nothing, silently.
 *
 * NOTHING IS IMPORTED FROM `deck/components.js`, deliberately. Every custom
 * component in this deck renders THROUGH a Spectacle primitive -- `SlideHeading`
 * is a `Heading`, `Eyebrow` is a `Text`, `AccentRule` is a `Box`, `TakeawayCard`
 * is a `FlexBox` of `Text`s -- so Spectacle identity plus the deck's own class
 * vocabulary already covers them. Reaching for it would also close a loop:
 * `components.js` statically imports `chat/bridge.js` and `chat/toggle.js`, so
 * from here that is `chat -> deck -> chat`.
 *
 * The unknown-component default is DESCEND. A layout wrapper contributes no
 * prose and its children do, so anything not listed below is treated as
 * transparent -- which is also what makes this survive new slide components
 * being added without the harvest going blind to them.
 */
import {
  Box,
  CodePane,
  FlexBox,
  Grid,
  Heading,
  ListItem,
  Markdown,
  Notes,
  OrderedList,
  Quote,
  Table,
  TableCell,
  TableRow,
  Text,
  UnorderedList,
} from "spectacle";
import { classOf, hasClass, propsOf, SKIP, textOf, walk } from "./fiber.js";
import {
  emitNode,
  flattenNode,
  isNodeKind,
  normalize,
  roleOf,
} from "./nodes.js";

/**
 * `Heading` fontSize -> heading level.
 *
 * The prop is the deck's own vocabulary (`fontSize="h1"`), not a CSS size, and
 * `SlideHeading` requires every call site to pass one -- see the comment on it
 * in `components.js`, which records two titles shipping at 16px when it was
 * optional. Chapter dividers pass a raw `"88px"` instead and are caught by the
 * class rules below.
 */
const HEADING_SIZE = { h1: 1, h2: 2, h3: 3, h4: 4 };

/** Classes that mean "this is the slide's own top-level title". */
const TITLE_CLASSES = ["title-display", "divider__title"];

/**
 * `Text` nodes that are labels rather than prose.
 *
 * These read as headings on the slide -- an eyebrow above a title, the label
 * column of a rows grid, the claim on a takeaway card -- but they are `Text`
 * because Spectacle's `Heading` would bring type scale they do not want. Bold
 * is the closest Markdown has to "prominent but not structural".
 */
const LABEL_CLASSES = [
  "eyebrow",
  "card__label",
  "audience__who",
  "takeaway__text",
  "matrix__name",
];

/** Decoration with no prose in it. Skipped whole. */
const DECORATION_CLASSES = [
  "accent-rule",
  "divider__numeral",
  "code-frame__dots",
  "step-placeholder",
];

/**
 * Layout primitives that are really content cells.
 *
 * `Box` and `Grid` are transparent here, which is right for the wrappers they
 * usually are -- but `MatrixSlide` builds its rows out of bare `Box`es
 * (`components.js`: one Grid holds every cell so the label column stays
 * aligned), and transparent means their text came back as INLINE with no block
 * to attach to. Slide-level inline text is discarded by `render`, so all ten
 * cells of slide 21 -- every runtime the talk compares -- were silently absent
 * from the harvest. Measured: "transformers.js" appeared zero times in a
 * 16,100-character dump of the deck.
 *
 * The label half is bold for the same reason `LABEL_CLASSES` is: it reads as a
 * heading on the slide without being one structurally.
 */
const CELL_CLASSES = [
  ["matrix__name", true],
  ["matrix__note", false],
];

const EMPTY = { inline: "", blocks: [] };

const block = (text, kind = "block") => ({ kind, text });

const inline = (text) => ({ inline: text, blocks: [] });

const merge = (parts) => ({
  inline: parts.map((p) => p.inline).join(""),
  blocks: parts.flatMap((p) => p.blocks),
});

/**
 * `em()` returns an HTML STRING, not an element.
 *
 * `components.js` defines it as `<span class="em">${text}</span>`, so it lands
 * literally inside markdown-slide source and inside note text, where nothing
 * will ever render it. Emphasis is the honest Markdown for it.
 */
const unwrapEm = (text) =>
  text.replace(/<span class="em">([\s\S]*?)<\/span>/g, "*$1*");

/**
 * Strip the indentation a template literal baked in.
 *
 * Notes are authored inside `htm` templates nested four or five levels deep, so
 * every line arrives with twenty-odd leading spaces -- enough for Markdown to
 * read the whole note as an indented code block.
 */
const dedent = (text) => {
  const lines = text.replace(/\t/g, "  ").split("\n");

  // THE FIRST LINE DOES NOT VOTE. It follows an opening backtick or a `${`, so
  // it is flush against the template's own indentation while every line under
  // it is indented to the source. Letting it into the minimum is what left the
  // three `DemoSlide` notes with fourteen spaces on every line but their first:
  // `DemoSlide` joins its `backup` string ahead of its `notes` string, so the
  // note begins with "**IF IT BREAKS:**" at column zero, the minimum came out
  // as zero, and nothing was stripped.
  const indents = lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => line.match(/^ */)[0].length);
  const pad = indents.length ? Math.min(...indents) : 0;

  return lines
    .map((line, i) => (i ? line.slice(pad) : line))
    .join("\n")
    .trim();
};

/**
 * Push headings down so a slide's own `#` nests under the document's.
 *
 * Only applied to the rendered copy. The structured output keeps the source
 * exactly as authored, because that is the thing worth being able to diff.
 *
 * The `\s` after the hashes is load-bearing: it keeps this off CSS id selectors
 * (`#app {`) inside a fenced block.
 */
const shiftHeadings = (md, by) =>
  by <= 0
    ? md
    : md.replace(
        /^(#{1,6})(\s)/gm,
        (_, hashes, space) =>
          "#".repeat(Math.min(6, hashes.length + by)) + space,
      );

/** A fenced block, with the filename on the line above when there is one. */
const fence = (file, language, source) => {
  const body = ["```" + (language ?? ""), source, "```"].join("\n");
  return file ? `\`${file}\`\n\n${body}` : body;
};

/**
 * React elements -> the string they would render.
 *
 * Notes are read from PROPS rather than from a fiber subtree, because
 * `Notes` renders `null` outside presenter mode and therefore has no subtree.
 * What it has is `props.children`: a `Markdown` element wrapping the source.
 */
const flattenElement = (node) => {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenElement).join("");
  return node.props ? flattenElement(node.props.children) : "";
};

/**
 * Read one `Notes` fiber into the slide's note pile.
 *
 * The run-of-spaces collapse is not cosmetic. A markdown slide's `Notes:` line
 * must be ONE logical line continued with a trailing `\` -- see the two rules
 * on `mdSlideProps` in `components.js` -- so the note arrives as a single line
 * carrying every space of the template literal's indentation inside it, twenty
 * at a time. Leading indentation is left alone, because that is what keeps a
 * wrapped bullet attached to its bullet.
 */
const collectNote = (fiber, ctx) => {
  const note = dedent(unwrapEm(flattenElement(propsOf(fiber).children)))
    .replace(/(\S) {2,}/g, "$1 ")
    // `DemoSlide` joins `backup` and `notes` with a blank line, and each string
    // already ends with one, so the seam arrives as three newlines. Flattened
    // here rather than in the document render, so the `notes` FIELD and the text
    // between the tags are the same string.
    .replace(/\n{3,}/g, "\n\n");
  if (note) ctx.sink.notes.push(note);
};

/**
 * A markdown slide's source, cleaned of the two things that are not prose.
 *
 * THE `Notes:` LINE IS STILL IN THE SOURCE. Spectacle renders it into a `Notes`
 * element AND leaves it in the string it was parsed from, so emitting the
 * source verbatim printed every markdown slide's speaker notes inline, in the
 * body, immediately above the `### Speaker notes` section repeating them.
 *
 * Phosphor icons are authored as raw `<i>` tags inside these slides. They are
 * the same decoration the `<i>` rule drops everywhere else; leaving them in
 * only here would make the markdown slides the noisy ones.
 */
const cleanSource = (text) =>
  unwrapEm(dedent(text))
    .replace(/<i class="ph[^"]*"[^>]*>\s*<\/i>\s*/g, "")
    .replace(/\n?^Notes:[\s\S]*/m, "")
    .trim();

const headingLevel = (fiber, ctx) => {
  const { fontSize } = propsOf(fiber);
  const level = TITLE_CLASSES.some((cls) => hasClass(fiber, cls))
    ? 1
    : (HEADING_SIZE[fontSize] ?? (hasClass(fiber, "slide-subtitle") ? 3 : 2));
  return Math.min(6, ctx.headingBase + level - 1);
};

/**
 * A table, assembled from the row blocks its children produced.
 *
 * Unreachable today: the only tables in this deck are inside markdown slides,
 * whose source is emitted verbatim without ever descending. Kept because the
 * component map in `components.js` maps `table`/`tr`/`td`, so the first
 * prop-driven table would otherwise come out as a run of loose paragraphs.
 */
const tableBlock = (rows) => {
  if (!rows.length) return [];
  const width = rows[0].split("|").length - 2;
  const rule = `|${" --- |".repeat(Math.max(width, 1))}`;
  return [block([rows[0], rule, ...rows.slice(1)].join("\n"))];
};

/**
 * A fiber's children.
 *
 * THE SINGLE-TEXT-CHILD CASE IS NOT AN EDGE CASE. React does not create a fiber
 * for an element whose only child is a string or a number -- it sets the text
 * on the host node directly (`shouldSetTextContent`) and leaves `fiber.child`
 * null, with the string still sitting in props.
 *
 * Nearly every heading in this deck is `<Heading>Hi!</Heading>`, so missing
 * this did not lose an edge case: it lost 25 of 35 slide titles, every card
 * label, and every code-pane filename, while slides whose text happened to sit
 * beside an icon came through fine. The output looked plausible enough that the
 * gap read as "these slides have no headings."
 */
const childrenOf = (fiber, ctx) => {
  if (fiber && !fiber.child) {
    const { children } = propsOf(fiber);
    const type = typeof children;
    if (type === "string" || type === "number") return inline(String(children));
    return EMPTY;
  }

  const parts = [];
  for (let node = fiber?.child; node; node = node.sibling) {
    parts.push(serialize(node, ctx));
  }
  return merge(parts);
};

/** Wrap children's inline content in a Markdown delimiter, keeping any blocks. */
const wrap = (kids, delimiter) => {
  const text = kids.inline.trim();
  return text
    ? { inline: `${delimiter}${text}${delimiter}`, blocks: kids.blocks }
    : kids;
};

/** Emit a block from children's inline text, keeping any nested blocks after it. */
const asBlock = (kids, format, kind) => {
  const text = normalize(kids.inline);
  return text
    ? { inline: "", blocks: [block(format(text), kind), ...kids.blocks] }
    : { inline: "", blocks: kids.blocks };
};

const serializeHost = (fiber, ctx) => {
  const tag = fiber.type;

  // Phosphor icons are `<i>` with no children; an `<svg>` is Spectacle's own
  // chrome. Neither carries prose, and both would otherwise leak class soup.
  if (tag === "i" || tag === "svg") return EMPTY;
  if (tag === "br") return inline(" ");

  if (tag === "img") {
    const { src, alt } = propsOf(fiber);
    return inline(`![${alt ?? ""}](${src ?? ""})`);
  }

  // The filename bar renders BEFORE the pane it names, so stashing it here
  // means the `CodePane` below finds it waiting. Reading it off the DOM was
  // what forced the old harvest to de-interleave "register-tool.js" from the
  // first line of source.
  if (hasClass(fiber, "code-frame__name")) {
    ctx.sink.filename = normalize(childrenOf(fiber, ctx).inline) || null;
    return EMPTY;
  }
  if (DECORATION_CLASSES.some((cls) => hasClass(fiber, cls))) return EMPTY;

  const kids = childrenOf(fiber, ctx);

  if (tag === "strong" || tag === "b") return wrap(kids, "**");
  if (tag === "em" || hasClass(fiber, "em")) return wrap(kids, "*");
  if (tag === "code") return wrap(kids, "`");
  if (tag === "a") {
    const { href } = propsOf(fiber);
    return href
      ? { inline: `[${kids.inline.trim()}](${href})`, blocks: kids.blocks }
      : kids;
  }
  return kids;
};

function serialize(fiber, ctx) {
  const text = textOf(fiber);
  if (text !== null) return inline(text);

  const type = fiber.type;
  if (!type) return childrenOf(fiber, ctx);

  // --- Content that lives in props, not in a subtree ------------------------

  // Notes render `null`, so there is no subtree to walk and nothing to double
  // count. Collected rather than emitted: they are the presenter's own asides,
  // full of TODOs, and a consumer has to be able to drop them wholesale.
  if (type === Notes) {
    collectNote(fiber, ctx);
    return EMPTY;
  }

  // A markdown slide's source, exactly as authored. Descending into what
  // Spectacle built from it would report the same content a second time.
  if (type === Markdown) {
    const source = cleanSource(String(propsOf(fiber).children ?? ""));
    if (!source) return EMPTY;
    ctx.sink.source = source;

    // ...except for the notes, which are DOWN here rather than up beside the
    // slide. Spectacle parses the `Notes:` line out of the markdown and renders
    // it as a `Notes` element among the children being skipped, so all seven
    // markdown slides came back noteless until this scan went in. Hand-written
    // slides are the other way round -- `MdNotes` puts `Markdown` INSIDE
    // `Notes` -- and that direction is safe because the branch above returns
    // without descending.
    //
    // ADDRESSABLE NODES ARE DOWN HERE TOO, and they are the reason this scan now
    // does two jobs. The source above is the right thing to SERIALIZE -- it is
    // what the author wrote -- but it is one opaque string, so a markdown slide
    // had nothing to point at. Spectacle builds the source into real components
    // through `MARKDOWN_COMPONENTS` in `deck/components.js` (`p` is a `Text`,
    // `h1`-`h4` reach `Heading` through `SlideHeading`, `li` is a `ListItem`),
    // so the nodes are here for the taking. Measured: 33 across the 7 markdown
    // slides, which are otherwise the least addressable in the deck despite
    // being the only ones whose provenance is exact.
    //
    // NO DOUBLE COUNT. Nodes are a separate sink from blocks, and this branch
    // still returns the source as the one and only block.
    walk(fiber.child, (node) => {
      if (node.type === Notes) {
        collectNote(node, ctx);
        // `Notes` renders null so it has no subtree today, but its note lives in
        // props as a `Markdown` element -- and the day that renders, descending
        // would address the presenter's asides as slide content.
        return SKIP;
      }
      if (isNodeKind(node)) {
        emitNode(ctx, node, roleOf(node), normalize(flattenNode(node)));
      }
      // DESCENDS through an emitted node, because a nested list sits INSIDE its
      // parent `ListItem` and its items are separate bullets on the slide. This
      // used to return SKIP here, which cost slide 9 three addressable nodes:
      // the sub-items had no id at all, while their text was glued into the
      // parent's. `flattenNode` stopping at a list is the other half -- together
      // they give one node per visible line.
      return undefined;
    });

    return {
      inline: "",
      blocks: [block(shiftHeadings(source, ctx.headingBase - 1))],
    };
  }

  // The pane's own string, with its language. No Prism spans, no `.linenumber`
  // gutter to strip out of a clone, no whitespace to reconstruct.
  if (type === CodePane) {
    const { language, children } = propsOf(fiber);
    const source = String(children ?? "").trim();
    if (!source) return EMPTY;
    const file = ctx.sink.filename;
    ctx.sink.filename = null;
    ctx.sink.code.push({ file, language: language ?? null, source });
    // A code pane is addressable as a WHOLE, by its filename rather than by its
    // source: the text is hundreds of tokens and nothing downstream is going to
    // edit a line of it through a 2B model.
    emitNode(ctx, fiber, "code", file ?? language ?? "code");
    return { inline: "", blocks: [block(fence(file, language, source))] };
  }

  // --- Block-level components ----------------------------------------------

  // NODE TEXT IS THE RAW RUN, NOT THE RENDERED ONE, which is why these emit
  // through `flattenNode` rather than reusing the `kids.inline` beside them.
  // Serialization decorates as it goes -- a `takeaway__text` becomes `**...**`,
  // a link becomes `[text](href)`, an image becomes `![](src)` -- and none of
  // that is on the slide. Measured on this deck: the author bio came back as
  // "![](https://encrypted-tbn0.gstatic.com/images?q=...) I lead technology &
  // OSS at [Nearform](https://nearform.com)", where 90% of the tokens are a URL
  // and the phrase a user would ask to change is split around the markup.
  //
  // It also makes the two emission paths agree. The markdown-slide scan below
  // has no `kids` to reuse and always flattened; having the component path
  // decorate and the markdown path not would make a node's text mean something
  // different depending on which kind of slide it came from.
  if (type === Heading) {
    emitNode(
      ctx,
      fiber,
      roleOf(fiber, "heading"),
      normalize(flattenNode(fiber)),
    );
    const level = "#".repeat(headingLevel(fiber, ctx));
    return asBlock(childrenOf(fiber, ctx), (t) => `${level} ${t}`);
  }

  if (type === Text) {
    emitNode(ctx, fiber, roleOf(fiber, "text"), normalize(flattenNode(fiber)));
    const label = LABEL_CLASSES.some((cls) => hasClass(fiber, cls));
    return asBlock(childrenOf(fiber, ctx), (t) => (label ? `**${t}**` : t));
  }

  if (type === Quote) {
    emitNode(ctx, fiber, roleOf(fiber, "quote"), normalize(flattenNode(fiber)));
    return asBlock(childrenOf(fiber, ctx), (t) => `> ${t}`);
  }

  if (type === UnorderedList || type === OrderedList) {
    const list = {
      depth: ctx.list.depth + 1,
      ordered: type === OrderedList,
      index: 0,
    };
    return { inline: "", blocks: childrenOf(fiber, { ...ctx, list }).blocks };
  }

  if (type === ListItem) {
    const { list } = ctx;
    emitNode(
      ctx,
      fiber,
      roleOf(fiber, "bullet"),
      normalize(flattenNode(fiber)),
    );
    const kids = childrenOf(fiber, ctx);
    const marker = list.ordered ? `${(list.index += 1)}.` : "*";
    const indent = "  ".repeat(Math.max(0, list.depth - 1));
    // `kind: "list"` keeps consecutive items one blank line closer together
    // than paragraphs, which is the difference between a list and a run of
    // loose lines. Nested items inherit it, so a sublist stays attached.
    return asBlock(kids, (t) => `${indent}${marker} ${t}`, "list");
  }

  if (type === Table) {
    const kids = childrenOf(fiber, ctx);
    const rows = kids.blocks.filter((b) => b.kind === "row").map((b) => b.text);
    return {
      inline: "",
      blocks: [
        ...tableBlock(rows),
        ...kids.blocks.filter((b) => b.kind !== "row"),
      ],
    };
  }

  if (type === TableRow) {
    const cells = [];
    for (let node = fiber.child; node; node = node.sibling) {
      cells.push(normalize(serialize(node, ctx).inline));
    }
    return { inline: "", blocks: [block(`| ${cells.join(" | ")} |`, "row")] };
  }

  if (type === TableCell) return childrenOf(fiber, ctx);

  // --- Everything else ------------------------------------------------------

  // `Link` and `Image` are NOT handled here, deliberately. Both are styled
  // wrappers that render a host `<a>` / `<img>` carrying the same props one
  // level down, so handling the component too wrapped every link twice:
  // `[[](https://nearform.com)](https://nearform.com)`. Letting them fall
  // through to the host rules below also picks up the raw `<a>` and `<img>`
  // that `media.js` injects, which a component-level rule would have missed.

  if (typeof type === "string") return serializeHost(fiber, ctx);

  // `FlexBox`, `Box`, `Grid`, `Appear`, `Fragment`, every styled-components
  // wrapper, every custom slide component: transparent. Listed for the reader
  // rather than for the code, which would descend anyway.
  if (type === Box || type === FlexBox || type === Grid) {
    if (DECORATION_CLASSES.some((cls) => hasClass(fiber, cls))) return EMPTY;

    const cell = CELL_CLASSES.find(([cls]) => hasClass(fiber, cls));
    if (cell) {
      emitNode(ctx, fiber, roleOf(fiber), normalize(flattenNode(fiber)));
      const [, bold] = cell;
      return asBlock(
        childrenOf(fiber, ctx),
        (t) => (bold ? `**${t}**` : t),
        "list",
      );
    }
  }
  return childrenOf(fiber, ctx);
}

/** Blocks -> text. Lists close up; everything else gets a blank line. */
const render = (blocks) =>
  blocks
    .reduce((out, b, i) => {
      if (!i) return b.text;
      const tight = blocks[i - 1].kind === "list" && b.kind === "list";
      return out + (tight ? "\n" : "\n\n") + b.text;
    }, "")
    .trim();

/**
 * One slide, read from its `Slide` fiber.
 *
 * Walks `fiber.child` rather than the fiber itself, so a slide's siblings --
 * the other 34 -- stay out of it. That boundary is the whole reason this
 * anchors at `Slide` instead of climbing from a DOM node.
 */
export const serializeSlide = (slideFiber, { headingBase = 3 } = {}) => {
  const sink = { code: [], notes: [], nodes: [], filename: null, source: null };
  const ctx = {
    headingBase,
    list: { depth: 0, ordered: false, index: 0 },
    sink,
  };

  const parts = [];
  for (let node = slideFiber?.child; node; node = node.sibling) {
    parts.push(serialize(node, ctx));
  }

  const body = render(merge(parts).blocks);
  return {
    kind: sink.source ? "markdown" : "component",
    body,
    source: sink.source,
    code: sink.code,
    notes: sink.notes.join("\n\n"),
    nodes: sink.nodes,
    className: classOf(slideFiber),
  };
};
