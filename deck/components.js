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

const html = htm.bind(createElement);

const urlParams = new URLSearchParams(window.location.search);
const prefersReducedMotion = matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const animationsEnabled =
  urlParams.get("animate") === "false" || prefersReducedMotion ? false : true;

export const AppearComponent = animationsEnabled ? Appear : Fragment;
const animateListItems = animationsEnabled ? { animateListItems: true } : {};

/**
 * Markdown tag -> component map.
 *
 * Markdown headings are the one thing in the deck that CSS cannot otherwise
 * reach: Spectacle's `Heading` renders a styled div, so there is no `<h1>` to
 * select, and the styled-system props it used to leak onto the DOM as
 * attributes get filtered back out by the `shouldForwardProp` guard that
 * styled-components v6 needs. `className` is the only hook that survives both,
 * and the component map is the only place to attach one.
 *
 * The non-heading entries are not decoration -- `componentMap` REPLACES
 * Spectacle's default map rather than merging with it, so leaving one out
 * drops that tag back to unstyled browser HTML. This mirrors Spectacle 10.2.1's
 * internal default (which is not exported) using its public components; the
 * only changes are the heading classNames. `animateListItems` still swaps in
 * its own `li` afterwards, so list reveals keep working.
 */
const mdHeading = (fontSize, className) => (props) =>
  html`<${Heading} ...${props} fontSize=${fontSize} className=${className} />`;

const MARKDOWN_COMPONENTS = {
  p: Text,
  h1: mdHeading("h1", "slide-title"),
  h2: mdHeading("h2", "slide-title"),
  h3: mdHeading("h3", "slide-subtitle"),
  h4: mdHeading("h4", "slide-subtitle"),
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
 * Shared props for every `MarkdownSlideSet`.
 *
 * `componentProps` reaches every mapped component, which is what left-aligns
 * markdown to match the prop-driven slides around it -- Spectacle's `Heading`
 * defaults to centered.
 */
export const mdSlideProps = {
  ...animateListItems,
  componentProps: { textAlign: "left" },
  componentMap: MARKDOWN_COMPONENTS,
};

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

export const Icon = ({ name, fill = true, color, className, style }) =>
  html`<i
    class="ph${fill ? "-fill" : ""} ph-${name}${className
      ? ` ${className}`
      : ""}"
    style=${{ color, ...style }}
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
    margin="0"
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
 */
export const Template = ({ slideNumber, numberOfSlides } = {}) => {
  // The title slide carries its own composition; chrome would only crowd it,
  // and a bar at 1-of-N there is a stub rather than information.
  if (slideNumber === 1) return null;

  const progress = numberOfSlides
    ? Math.round((slideNumber / numberOfSlides) * 100)
    : 0;

  return html`
    <${Box} className="deck-chrome" position="absolute" bottom=${0} width=${1}>
      <${FlexBox}
        className="deck-meta"
        justifyContent="space-between"
        alignItems="center"
        width=${1}
      >
        <${FlexBox} alignItems="center">
          <${FullScreen} color=${colors.midnight[30]} size=${20} />
        <//>
        <${Text} className="deck-meta__count" fontSize="18px" margin="0">
          ${String(slideNumber).padStart(2, "0")} / ${String(numberOfSlides).padStart(2, "0")}
        </${Text}>
      <//>
      <${Box} className="deck-progress" width=${1}>
        <${Box} className="deck-progress__fill" width=${`${progress}%`} />
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
 * Code slide with a filename bar.
 *
 * The bar is not chrome for its own sake: these snippets are real files under
 * `examples/`, and naming them tells the audience the code is honest rather
 * than written for the slide.
 */
export const JsSlide = ({ title, filename, code, notes, chapter }) => html`
  <${Slide} className=${chapter ? chapterClass(chapter) : ""}>
    <${Heading} className="slide-subtitle" fontSize="h3" textAlign="left" margin="0 0 24px">${title}</${Heading}>
    <div className="code-frame">
      ${
        filename
          ? html`<div className="code-frame__bar">
              <span className="code-frame__dots" />
              <span className="code-frame__name">${filename}</span>
            </div>`
          : null
      }
      <${CodePane} language="javascript" showLineNumbers=${true}>${code}</${CodePane}>
    </div>
    <${MdNotes} notes=${notes} />
  </${Slide}>
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
    <${Slide}
      className=${`divider ${chapterClass(n)}`}
      ...${photoBackground(background)}
      ...${rest}
    >
      <${FlexBox} height="100%" flexDirection="column" justifyContent="center" alignItems="start">
        <${Box} className="divider__numeral" aria-hidden="true">
          ${chapterNumber(n)}
        <//>
        <${Eyebrow}>Episode ${chapterNumber(n)}</${Eyebrow}>
        <${Heading}
          className="slide-title divider__title"
          fontSize=${fontSize}
          color="primary"
          textAlign="left"
          margin="12px 0 0"
        >
          ${title}
        </${Heading}>
        <${AccentRule} />
      <//>
    </${Slide}>
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
export const RowsSlide = ({ title, sections = [], notes, chapter }) => {
  // Calculate grid layout based on sections
  const maxItems = Math.max(
    ...sections.map((section) => Math.max(section.items.length, 1)),
    1,
  );
  const gridRows = `repeat(${sections.length}, 1fr)`;
  const gridColumns = `repeat(${maxItems + 1}, 1fr)`;

  return html`
    <${Slide} className=${chapter ? chapterClass(chapter) : ""}>
      <${Heading} className="slide-title" textAlign="left" margin="0">${title}</${Heading}>
      <${FlexBox} justifyContent="center" alignItems="center">
        <${Grid}
          gridTemplateColumns=${gridColumns}
          gridTemplateRows=${gridRows}
          gridGap="20px"
          width="100%"
        >
          ${sections.map((section) => {
            const itemCount = Math.max(section.items.length, 1);
            const extraItemsCount = maxItems - itemCount;

            return html`
              <${Fragment}>
                <!-- Section label - spans all items in this section -->
                <${FlexBox} ...${CARD_PROPS} className="card card--label" height="100%">
                  <${Text} className="card__label" fontSize="30px" margin="0">
                    ${section.title}
                  </${Text}>
                </${FlexBox}>

                <!-- Section content cells -->
                ${section.items.map((item, i) => {
                  // Handle both string items and { icon, text } objects
                  const itemText = typeof item === "string" ? item : item.text;
                  const itemIcon =
                    typeof item === "object" && item.icon ? item.icon : null;

                  return html`
                    <${FlexBox} key=${i} ...${CARD_PROPS}>
                      <${Text} fontSize="28px" margin="0">
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

                <!-- Empty padding -->
                ${Array.from({ length: extraItemsCount }).map(
                  (_, i) => html`<${Box} key=${i}></${Box}>`,
                )}
              </${Fragment}>
            `;
          })}
        </${Grid}>
      </${FlexBox}>
      <${MdNotes} notes=${notes} />
    </${Slide}>
  `;
};
