/* global URLSearchParams:false,window:false,matchMedia:false */
import { Fragment, createElement } from "react";
import htm from "htm";
import {
  Appear,
  Slide,
  Heading,
  CodePane,
  FlexBox,
  Box,
  FullScreen,
  Grid,
  Text,
  Notes,
  Markdown,
  Quote,
  UnorderedList,
  OrderedList,
  ListItem,
  Image,
  Link,
  Table,
  TableRow,
  TableCell,
} from "spectacle";
import { LiveEditor, LivePreview, LiveError, LiveProvider } from "react-live";
import { themes } from "prism-react-renderer";
import { colors, photoBackground } from "./theme.js";
import { chapterClass, chapterNumber } from "./chapters.js";
import { VERDICTS } from "./takeaways.js";
import { DeckBridge } from "../chat/bridge.js";
import { ChatToggle } from "../chat/toggle.js";

const html = htm.bind(createElement);

/*
 * ZERO IS AN INDEX, NOT A LENGTH.
 *
 * styled-system resolves the space-group props -- `margin`, `padding`, `top`,
 * `right`, `bottom`, `left` and their per-side forms -- through `theme.space`
 * whenever the value is a bare number or a bare numeric string. This theme's
 * `space` starts at 16 (see `theme.js`), so `margin="0"` and `bottom={0}` both
 * mean SIXTEEN PIXELS, and they mean it silently: the deck renders, nothing
 * warns, and the layout is just 16px looser than it was written to be.
 *
 * It cost the deck real canvas. Every takeaway card carried 32px of margin it
 * had asked not to have, and the chrome floated 16px off the bottom edge.
 *
 * Write `"0px"`. A value with units skips the scale lookup. Any other length
 * (`"8px 0 0"`, `"12px"`) is already safe -- only a bare `0` / `"0"` is a key.
 */

const urlParams = new URLSearchParams(window.location.search);
const prefersReducedMotion = matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const animationsEnabled =
  urlParams.get("animate") === "false" || prefersReducedMotion ? false : true;

export const AppearComponent = animationsEnabled ? Appear : Fragment;
const animateListItems = animationsEnabled ? { animateListItems: true } : {};

/**
 * Every heading in the deck.
 *
 * ALWAYS pass an explicit `fontSize`. Spectacle's `Heading` carries its default
 * size in `defaultProps`, which React 19 no longer applies to function
 * components -- so a heading with no `fontSize` (or an explicit `undefined`)
 * falls all the way back to the 16px base and reads as body text. Two RowsSlide
 * titles shipped at 16px before anyone noticed.
 *
 * A class is the only hook CSS has on a heading: Spectacle's `Heading` renders a
 * styled div, so there is no `<h1>` to select, and the styled-system props it
 * used to leak onto the DOM as attributes get filtered back out by the
 * `shouldForwardProp` guard that styled-components v6 needs.
 *
 * That class used to be hand-typed at every call site, which is how the live-edit
 * slide ended up with no class at all and quietly outside the heading treatment.
 * Going through here makes the class automatic and opting out explicit.
 *
 *   variant  -- "title" for a slide title, "subtitle" for the smaller heading
 *               that sits above a code pane. Picks `.slide-title` /
 *               `.slide-subtitle`, which carry the tracking and leading.
 *   fixed    -- this heading's color is deliberate (chapter dividers, the
 *               AgntCon slide), so the `[data-heading]` treatment in styles.css
 *               skips it.
 *
 * `className` is appended rather than replaced, so a caller can add a one-off
 * class without losing the system ones.
 */
export const SlideHeading = ({
  variant = "title",
  fixed = false,
  className = "",
  ...rest
}) => html`
  <${Heading}
    ...${rest}
    className=${[`slide-${variant}`, fixed && "heading--fixed", className]
      .filter(Boolean)
      .join(" ")}
  />
`;

/**
 * Markdown tag -> component map.
 *
 * The non-heading entries are not decoration -- `componentMap` REPLACES
 * Spectacle's default map rather than merging with it, so leaving one out
 * drops that tag back to unstyled browser HTML. This mirrors Spectacle 10.2.1's
 * internal default (which is not exported) using its public components; the
 * only changes are the headings, which route through `SlideHeading`.
 * `animateListItems` still swaps in its own `li` afterwards, so list reveals
 * keep working.
 */
const mdHeading = (fontSize, variant) => (props) =>
  html`<${SlideHeading} ...${props} fontSize=${fontSize} variant=${variant} />`;

const MARKDOWN_COMPONENTS = {
  p: Text,
  h1: mdHeading("h1", "title"),
  h2: mdHeading("h2", "title"),
  h3: mdHeading("h3", "subtitle"),
  h4: mdHeading("h4", "subtitle"),
  blockquote: Quote,
  ul: UnorderedList,
  ol: OrderedList,
  li: ListItem,
  img: Image,
  a: Link,
  table: Table,
  tr: TableRow,
  td: TableCell,
};

/**
 * Props for a `MarkdownSlideSet`, given the chapter it sits in.
 *
 * A function rather than a constant because of `className`. Spectacle builds a
 * markdown set's slides internally, so they cannot go through `DeckSlide` and
 * pick up `.slide` there -- and `.slide` is what reserves the deck chrome's
 * band. Every class a markdown slide needs is therefore assembled here, in one
 * place, from the one thing that varies.
 *
 * `componentProps` reaches every mapped component, which is what left-aligns
 * markdown to match the prop-driven slides around it -- Spectacle's `Heading`
 * defaults to centered.
 *
 * TWO RULES for the `Notes:` line inside a markdown slide, both learned the
 * hard way:
 *
 *   1. It must be ONE logical line. Continue it with a single trailing `\` so
 *      the template literal folds the newline away. A literal `\\` is a
 *      backslash, not a continuation, and everything after it falls through and
 *      renders as slide content -- which overflows the slide and is the only
 *      symptom you see.
 *   2. It must be PLAIN TEXT. Any inline markup silently truncates the note at
 *      the first marker: `em()` dies at the `<span`, and `**bold**` dies at the
 *      `**`. Use `em()` freely in slide bodies and in the `notes` PROP on
 *      hand-written slides (those go through `MdNotes` below, which renders
 *      full markdown) -- just never in a markdown slide's `Notes:`.
 */
export const mdSlideProps = (chapter) => ({
  ...animateListItems,
  componentProps: { textAlign: "left" },
  componentMap: MARKDOWN_COMPONENTS,
  className: `slide md ${chapterClass(chapter)}`,
});

/**
 * Slide-to-slide motion, handed to `Deck`.
 *
 * A short push in the direction of travel reads as pacing rather than
 * decoration. Empty when animations are off, which also covers
 * `prefers-reduced-motion`.
 */
export const deckTransition = animationsEnabled
  ? {
      from: { opacity: 0, transform: "translateX(28px)" },
      enter: { opacity: 1, transform: "translateX(0px)" },
      leave: { opacity: 0, transform: "translateX(-28px)" },
    }
  : {};

// Icon components
export const icon = (args) => {
  const {
    name,
    fill = true,
    color,
  } = typeof args === "object" ? args : { name: args };
  return `<i class="ph${fill ? "-fill" : ""} ph-${name}" ${color ? `style="color: ${color}"` : ""}></i>`;
};

export const Icon = ({ name, fill = true, color, className, style, title }) =>
  html`<i
    class="ph${fill ? "-fill" : ""} ph-${name}${className
      ? ` ${className}`
      : ""}"
    style=${{ color, ...style }}
    title=${title}
  ></i>`;

// Text styling components
//
// These resolve their color from `--chapter-accent`, which cascades down from
// the chapter class on the slide -- so emphasis picks up the section's accent
// automatically and falls back to the deck green outside a chapter.
export const em = (text) => `<span class="em">${text}</span>`;

/** Small tracked-out label that sits above a heading. */
export const Eyebrow = ({
  children,
  className = "",
  fontSize = "22px",
}) => html`
  <${Text}
    className=${`eyebrow ${className}`.trim()}
    fontSize=${fontSize}
    margin="0px"
  >
    ${children}
  </${Text}>
`;

/** Short accent bar standing in for a rule. */
export const AccentRule = ({ className = "" }) => html`
  <${Box} className=${`accent-rule ${className}`.trim()} />
`;

/**
 * Deck chrome: slide count and a progress bar on the bottom edge.
 *
 * Deliberately NOT chapter-colored. A deck-level template renders as a sibling
 * above every slide rather than inside the active one, so `--chapter-accent`
 * cannot cascade into it, and `SlideContext` carries no slide index to look the
 * chapter up from. The alternatives -- hardcoding slide-index ranges, or
 * selecting the active slide through its inline `display` style -- both go
 * stale silently, which is worse than neutral furniture. Chapter identity is
 * carried by the content area instead: dividers, rules, emphasis and markers.
 *
 * `bottom="0px"`, NOT `bottom={0}`. styled-system resolves `top/right/bottom/
 * left` through `theme.space`, so a bare `0` is an INDEX -- and `space[0]` is
 * 16px in this theme. The chrome spent the deck's life floating 16px off the
 * canvas edge because of it. A string with units skips the scale lookup.
 *
 * How much vertical space this band owns is `--chrome-h` in `styles.css`, and
 * every slide reserves exactly that much. Nothing here may size itself from its
 * own content: the counter is set in a webfont, so a content-height chrome
 * moves between first paint and font load, and the reservation would be wrong
 * for whichever of the two it was not measured against.
 */
export const Template = ({ slideNumber, numberOfSlides } = {}) => {
  // The title slide carries its own composition; a counter and a bar at 1-of-N
  // there are a stub rather than information, so both stay off it.
  //
  // This used to be `if (slideNumber === 1) return null`, and it cannot be that
  // any more. Spectacle calls `template` as a PLAIN FUNCTION inside `Deck`'s own
  // render rather than mounting it as a component, so anything with hooks in it
  // borrows Deck's hook list -- and an early return here would change the hook
  // count on the first navigation and take the deck down with it. `DeckBridge`
  // has hooks. It is safe only because it is an ELEMENT with its own fiber, and
  // only if it renders on every slide. Hence a branch on what the chrome
  // CONTAINS, never on whether the template renders at all.
  //
  // The empty band left on slide 1 costs nothing: `.deck-chrome` inherits
  // `pointer-events: none` from Spectacle's `TemplateWrapper` and paints no
  // background, so it neither shows nor blocks anything.
  const chrome = slideNumber !== 1;

  const progress = numberOfSlides
    ? Math.round((slideNumber / numberOfSlides) * 100)
    : 0;

  return html`
    <${Fragment}>
      <${DeckBridge} />
      <${Box}
        className="deck-chrome"
        position="absolute"
        bottom="0px"
        width=${1}
      >
        <${FlexBox}
          className="deck-meta"
          justifyContent="space-between"
          alignItems="center"
          width=${1}
        >
          ${
            "" /* Fullscreen first, robot second, on EVERY slide including the title.
                  The controls are not chrome in the decorative sense -- they are the
                  two things a presenter reaches for, and going fullscreen is the
                  first of them, which makes slide 1 the slide it is needed on most.
                  Gating it behind `chrome` alongside the counter and the progress bar
                  conflated "information about position in the deck", which a title
                  slide genuinely should not carry, with "controls", which it should.
                  Rendering unconditionally also means the robot's x needs no
                  reserved-box trickery to stay put. */
          }
          <${FlexBox} alignItems="center">
            <${FullScreen} color=${colors.midnight[30]} size=${20} />
            <${ChatToggle} />
          <//>
          ${
            "" /* The counter is the tallest thing in this row, so dropping it on the
                  title slide let the row collapse and lifted the robot 13px. Rendered
                  with `visibility: hidden` rather than omitted: the box keeps the row
                  at one height, so the robot holds its y as well as its x. */
          }
          <${Text}
            className=${`deck-meta__count${chrome ? "" : " deck-meta__count--reserved"}`}
            fontSize="18px"
            margin="0px"
            aria-hidden=${chrome ? undefined : true}
          >
            ${String(slideNumber).padStart(2, "0")} /
            ${String(numberOfSlides).padStart(2, "0")}
          </${Text}>
        <//>
        ${
          "" /* Reserved on the title slide, like the counter, and for a reason that is
                easy to miss: `.deck-chrome` bottom-aligns its contents, so omitting
                this 3.8px bar let the whole meta row DROP by 3.8px -- the icons sat
                lower on slide 1 and jumped up on the first navigation. Measured. */
        }
        <${Box}
          className=${`deck-progress${chrome ? "" : " deck-progress--reserved"}`}
          width=${1}
          aria-hidden=${chrome ? undefined : true}
        >
          <${Box} className="deck-progress__fill" width=${`${progress}%`} />
        <//>
      <//>
    <//>
  `;
};

const MdNotes = ({ notes }) =>
  !notes
    ? null
    : html`<${Notes}>
  <${Markdown} className="notes">
    ${notes}
  </${Markdown}>
</${Notes}>`;

// Slide components

/**
 * Every slide in the deck. Use this, never Spectacle's `Slide` directly.
 *
 * Its only job is to guarantee the `.slide` class, which is what reserves the
 * deck chrome's band (`--chrome-h`) inside the slide's own box. A slide that
 * misses the class lays its content out over the slide counter and looks
 * completely fine while doing it -- so the class cannot be something a call
 * site remembers to type.
 *
 * `chrome={false}` opts out, for the one slide `Template` draws no chrome on.
 *
 * The markdown sets are the exception that cannot go through here: Spectacle
 * builds their slides internally. They get the class from `mdSlideProps()`.
 */
export const DeckSlide = ({ className, chrome = true, children, ...rest }) => {
  const classes = ["slide", chrome ? null : "slide--full", className]
    .filter(Boolean)
    .join(" ");

  return html`<${Slide} className=${classes} ...${rest}>${children}</${Slide}>`;
};

/**
 * Code slide with a filename bar.
 *
 * The bar is not chrome for its own sake: these snippets are real files under
 * `examples/`, and naming them tells the audience the code is honest rather
 * than written for the slide.
 */
export const JsSlide = ({
  title,
  filename,
  code,
  notes,
  chapter,
  language = "javascript",
}) => html`
  <${DeckSlide} className=${chapter ? chapterClass(chapter) : ""}>
    <${SlideHeading} variant="subtitle" fontSize="h3" textAlign="left" margin="0 0 24px">${title}</${SlideHeading}>
    <div className="code-frame">
      ${
        filename
          ? html`<div className="code-frame__bar">
              <span className="code-frame__dots" />
              <span className="code-frame__name">${filename}</span>
            </div>`
          : null
      }
      <${CodePane} language=${language} showLineNumbers=${true}>${code}</${CodePane}>
    </div>
    <${MdNotes} notes=${notes} />
  </${DeckSlide}>
`;

/**
 * Chapter divider.
 *
 * Left-aligned against a scrimmed photo, with the chapter number ghosted in
 * behind the title so the section reads as an arrival rather than another
 * slide. `EPISODE NN` is the nod the deck's title has earned.
 */
export const TopicSlide = ({ chapter, fontSize = "88px", ...rest }) => {
  const { n, title, background } = chapter;

  return html`
    <${DeckSlide}
      className=${`divider ${chapterClass(n)}`}
      ...${photoBackground(background)}
      ...${rest}
    >
      <${FlexBox} height="100%" flexDirection="column" justifyContent="center" alignItems="start">
        <${Box} className="divider__numeral" aria-hidden="true">
          ${chapterNumber(n)}
        <//>
        <${Eyebrow}>Episode ${chapterNumber(n)}</${Eyebrow}>
        <${SlideHeading}
          className="divider__title"
          fixed=${true}
          fontSize=${fontSize}
          color="primary"
          textAlign="left"
          margin="12px 0 0"
        >
          ${title}
        </${SlideHeading}>
        <${AccentRule} />
      <//>
    </${DeckSlide}>
  `;
};

// Code editor component
//
// Set `noInline` for imperative snippets (e.g. registering a WebMCP tool).
// Without it, react-live requires the last expression to be renderable.
export const CodeEditor = ({
  code,
  noInline = false,
  editorHeight = "400px",
  previewHeight = "50px",
}) => html`
  <${LiveProvider}
    code=${code}
    language="javascript"
    theme=${themes.vsDark}
    noInline=${noInline}
  >
    <div className="code-editor-container">
      <${LiveEditor}
        className="react-live-editor"
        style=${{
          minHeight: editorHeight,
          maxHeight: editorHeight,
        }}
      />
      <${LiveError}
        className="react-live-error"
      />
      <${LivePreview}
        className="react-live-preview"
        style=${{
          minHeight: previewHeight,
          maxHeight: previewHeight,
        }}
      />
    </div>
  </${LiveProvider}>
`;

// Card layout props. The surface itself (fill, border, shadow) lives on the
// `.card` class in styles.css; only alignment belongs in props.
const CARD_PROPS = {
  className: "card",
  justifyContent: "center",
  alignItems: "center",
};

// Rows slide component: a grid of labelled rows, each with a row of items.
// `sections` is `[{ title, items: [string | { text, icon }] }]`.
//
// `dense` shrinks the padding and type so four rows, or three wide items in a
// row, still fit the 768px canvas. Without it those layouts run off the bottom
// and the right -- the grid sizes itself from its content and has no idea how
// tall a slide is.
export const RowsSlide = ({
  title,
  sections = [],
  notes,
  chapter,
  dense = false,
}) => {
  // Calculate grid layout based on sections
  const maxItems = Math.max(
    ...sections.map((section) => Math.max(section.items.length, 1)),
    1,
  );
  // `minmax(0, 1fr)`, not `1fr`. A bare `1fr` track is `minmax(auto, 1fr)`, and
  // that auto floor refuses to shrink below the row's content -- so a long row
  // pushes the grid past the height it was given and back over the slide's
  // bottom edge, which is exactly the failure the definite height is here to
  // prevent.
  const gridRows = `repeat(${sections.length}, minmax(0, 1fr))`;
  const gridColumns = `repeat(${maxItems + 1}, 1fr)`;
  const cardClass = dense ? "card card--dense" : "card";

  return html`
    <${DeckSlide} className=${chapter ? chapterClass(chapter) : ""}>
      <${SlideHeading}
        textAlign="left"
        margin="0px"
        fontSize=${dense ? "h3" : "h1"}
      >${title}</${SlideHeading}>
      ${"" /* `flex="1"` + `minHeight="0"` is what makes the `1fr` rows mean something. Without a definite height the grid sizes from its content, the rows are as tall as their text, and the whole block can run past the bottom of the slide -- which is what the `.card--rows` padding used to be compensating for. */}
      <${FlexBox} justifyContent="center" alignItems="center" flex="1" minHeight="0">
        <${Grid}
          gridTemplateColumns=${gridColumns}
          gridTemplateRows=${gridRows}
          gridGap=${dense ? "10px" : "14px"}
          width="100%"
          height="100%"
        >
          ${sections.map((section) => {
            const itemCount = Math.max(section.items.length, 1);
            const extraItemsCount = maxItems - itemCount;

            return html`
              <${Fragment}>
                ${"" /* Section label -- spans all items in this section */}
                <${FlexBox} ...${CARD_PROPS} className=${`${cardClass} card--label`} height="100%">
                  <${Text} className="card__label" fontSize=${dense ? "24px" : "30px"} margin="0px">
                    ${section.title}
                  </${Text}>
                </${FlexBox}>

                ${section.items.map((item, i) => {
                  // Handle both string items and { icon, text } objects
                  const itemText = typeof item === "string" ? item : item.text;
                  const itemIcon =
                    typeof item === "object" && item.icon ? item.icon : null;

                  return html`
                    <${FlexBox} key=${i} ...${CARD_PROPS} className=${cardClass}>
                      <${Text} fontSize=${dense ? "22px" : "28px"} margin="0px">
                        <${FlexBox} alignItems="center">
                          ${
                            itemIcon
                              ? html`<${Box} marginRight="0.5em">
                                  <${Icon}
                                    name=${itemIcon}
                                    className="card__icon"
                                  />
                                <//>`
                              : null
                          }
                          <${Box} textAlign="left">${itemText}<//>
                        </${FlexBox}>
                      </${Text}>
                    </${FlexBox}>
                  `;
                })}

                ${Array.from({ length: extraItemsCount }).map(
                  (_, i) => html`<${Box} key=${i}></${Box}>`,
                )}
              </${Fragment}>
            `;
          })}
        </${Grid}>
      </${FlexBox}>
      <${MdNotes} notes=${notes} />
    </${DeckSlide}>
  `;
};

/**
 * One of the six takeaways.
 *
 * The number is a plain digit inside a circle drawn in CSS, not a dingbat
 * (U+279A-279F, the ➊-➏ the outline drafts in). Inter has no coverage there, so
 * those glyphs fall back to tofu -- a failure that shows up on the projector and
 * nowhere else. Drawn in CSS it also reads `--chapter-accent`, which a font glyph
 * could not.
 *
 * `detail` is a prop rather than a property of the takeaway so the same data can
 * be a dense tile on the roadmap slide and a full callout at a chapter's close.
 */
export const TakeawayCard = ({
  takeaway,
  detail = true,
  compact = false,
  className = "",
}) => {
  const { n, text, detail: detailText, verdict } = takeaway;
  const mark = verdict ? VERDICTS[verdict] : null;

  return html`
    <${FlexBox}
      className=${`card takeaway ${compact ? "takeaway--compact" : ""} ${className}`
        .replace(/\s+/g, " ")
        .trim()}
      alignItems="start"
      justifyContent="start"
    >
      <${Box} className="takeaway__badge">${n}<//>
      <${Box} className="takeaway__body">
        <${Text} className="takeaway__text" fontSize=${compact ? "22px" : "30px"} margin="0px">
          ${text}
        </${Text}>
        ${
          detail && detailText
            ? html`<${Text} className="takeaway__detail" fontSize=${compact ? "20px" : "24px"} margin="8px 0 0">
                ${detailText}
              </${Text}>`
            : null
        }
      <//>
      ${
        mark
          ? html`<${Icon}
              name=${mark.icon}
              className="takeaway__verdict"
              title=${mark.title}
            />`
          : null
      }
    <//>
  `;
};

/**
 * A column (or grid) of takeaway cards.
 *
 * `compact` is needed wherever more than three cards share a slide: the roadmap
 * and the closing recap both show all six, and at full size six cards plus their
 * part labels run off the bottom of the canvas.
 */
export const TakeawayList = ({
  items = [],
  detail = true,
  columns = 1,
  compact = false,
}) => html`
  <${Grid}
    className="takeaway-grid"
    gridTemplateColumns=${`repeat(${columns}, 1fr)`}
    gridGap=${compact ? "10px" : "18px"}
  >
    ${items.map(
      (item) =>
        html`<${TakeawayCard}
          key=${item.n}
          takeaway=${item}
          detail=${detail}
          compact=${compact}
        />`,
    )}
  </${Grid}>
`;

/**
 * A chapter's closing beat.
 *
 * Built from `byChapter(n)` at the call site rather than from hand-written copy,
 * so a takeaway cannot be declared in `takeaways.js` and then never land.
 */
export const TakeawaySlide = ({
  chapter,
  title,
  items = [],
  detail = true,
  columns = 1,
  compact = false,
  notes,
}) => html`
  <${DeckSlide} className=${chapter ? chapterClass(chapter) : ""}>
    <${SlideHeading} fontSize="h1" textAlign="left" margin="0 0 20px">${title}</${SlideHeading}>
    <${TakeawayList}
      items=${items}
      detail=${detail}
      columns=${columns}
      compact=${compact}
    />
    <${MdNotes} notes=${notes} />
  </${DeckSlide}>
`;

/**
 * The two halves of the room, side by side.
 *
 * Rendered twice by design -- once in the cold open as a promise, once at the
 * close as the payoff -- which is exactly why it is a component and not two
 * hand-built layouts. If the two versions drift, the callback stops reading as a
 * callback and turns into a slide the audience thinks they have already seen.
 *
 * `action` is what separates them: the cold open states who is in the room, the
 * close tells each half what to do about it.
 */
export const AudienceCards = ({ audiences = [], action = false }) => html`
  <${Grid} gridTemplateColumns="1fr 1fr" gridGap="24px">
    ${audiences.map(
      (audience) => html`
        <${FlexBox}
          key=${audience.key}
          className="card audience"
          flexDirection="column"
          alignItems="start"
          justifyContent="start"
        >
          <${Icon} name=${audience.icon} className="audience__icon" />
          <${Text} className="audience__who" fontSize="26px" margin="14px 0 0">
            ${audience.who}
          </${Text}>
          <${Text} className="audience__claim" fontSize="32px" margin="10px 0 0">
            ${audience.claim}
          </${Text}>
          ${
            action
              ? html`<${Text} className="audience__action" fontSize="26px" margin="16px 0 0">
                  ${audience.action}
                </${Text}>`
              : null
          }
        <//>
      `,
    )}
  </${Grid}>
`;

/**
 * A two-column reference table: label on the left, one line on the right.
 *
 * `RowsSlide` cannot do this job. Its cells are `.card` surfaces, and five of them
 * stacked is taller than the canvas even at `dense` -- the padding, border and
 * shadow are most of the height. Here the rows are hairline-separated instead, so
 * five (or more) fit comfortably and the slide reads as the reference table it is.
 *
 * One Grid holds every cell rather than a flex row per line, so the label column
 * stays aligned down the slide for free.
 */
export const MatrixSlide = ({ chapter, title, rows = [], notes }) => html`
  <${DeckSlide} className=${chapter ? chapterClass(chapter) : ""}>
    <${SlideHeading} fontSize="h1" textAlign="left" margin="0 0 20px">${title}</${SlideHeading}>
    <${Grid} className="matrix" gridTemplateColumns="auto 1fr">
      ${rows.map(
        (row, i) => html`
          <${Fragment} key=${i}>
            <${Box} className="matrix__name">
              ${
                row.icon
                  ? html`<${Icon} name=${row.icon} className="matrix__icon" />`
                  : null
              }
              ${row.name}
            <//>
            <${Box} className="matrix__note">${row.note}<//>
          </${Fragment}>
        `,
      )}
    </${Grid}>
    <${MdNotes} notes=${notes} />
  </${DeckSlide}>
`;

/**
 * A hand-off to a live demo.
 *
 * Its real job is the `backup` prop. Three times in this talk the slides stop
 * and a live app takes over, and the one thing that must not be improvised on
 * stage is what to do when the demo fails -- so the fallback plan is pushed into
 * the speaker notes, above everything else, at the moment it would be needed.
 */
// TODO(Ryan): Check this `backup` thing and see about video backups for live demos.
export const DemoSlide = ({
  chapter,
  label = "Live demo",
  app,
  url,
  points = [],
  notes,
  backup,
}) => html`
  <${DeckSlide} className=${chapter ? chapterClass(chapter) : ""}>
    <${FlexBox} height="100%" flexDirection="column" justifyContent="center" alignItems="start">
      <${Eyebrow}><${Icon} name="monitor-play" /> ${label}</${Eyebrow}>
      <${SlideHeading} fontSize="h1" textAlign="left" margin="10px 0 0">
        ${app}
      </${SlideHeading}>
      <${AccentRule} />
      ${
        url
          ? html`<${Text} className="demo__url" fontSize="26px" margin="24px 0 0">
              ${url}
            </${Text}>`
          : null
      }
      ${
        points.length
          ? html`<${UnorderedList} className="demo__points" margin="18px 0 0">
              ${points.map(
                (point, i) =>
                  html`<${ListItem} key=${i} fontSize="28px">${point}</${ListItem}>`,
              )}
            </${UnorderedList}>`
          : null
      }
    <//>
    <${MdNotes}
      notes=${[backup && `**IF IT BREAKS:** ${backup}`, notes]
        .filter(Boolean)
        .join("\n\n")}
    />
  </${DeckSlide}>
`;
