/* global URLSearchParams:false,window:false */
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
  AnimatedProgress,
  Grid,
  Text,
  Notes,
  Markdown,
} from "spectacle";
import { LiveEditor, LivePreview, LiveError, LiveProvider } from "react-live";
import { themes } from "prism-react-renderer";
import { theme, colors } from "./theme.js";

const html = htm.bind(createElement);

const urlParams = new URLSearchParams(window.location.search);
const animationsEnabled = urlParams.get("animate") === "false" ? false : true;
export const AppearComponent = animationsEnabled ? Appear : Fragment;
export const animateListItems = animationsEnabled
  ? { animateListItems: true }
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

export const iconArrow = icon({
  name: "arrow-right",
  fill: false,
  color: theme.colors.quaternary,
});

export const Icon = ({ name, fill = true, color, style }) =>
  html`<i
    class="ph${fill ? "-fill" : ""} ph-${name}"
    style=${{ color, ...style }}
  ></i>`;

export const IconLink = ({ name, href, fill = false, color }) => html`
  <a href=${href} style=${{ color, textDecoration: "none" }}
    ><${Icon} name=${name} fill=${fill}
  /></a>
`;

export const IconArrow = () => html`
  <${Icon} name="arrow-right" fill=${false} color=${theme.colors.quaternary} />
`;

// Text styling components
export const em = (text) =>
  `<span style="color: ${theme.colors.secondary};">${text}</span>`;

export const Em = ({ children }) =>
  html`<span style=${{ color: theme.colors.secondary }}>${children}</span>`;

export const Template = ({ color = "#fff", slideNumber } = {}) => {
  return html`
    <${FlexBox}
      justifyContent="space-between"
      position="absolute"
      bottom=${0}
      width=${1}
    >
      <${Box} padding="0 1em">
        <${FullScreen} color=${color} />
      <//>
      <${Box} padding="1em">
        <${slideNumber === 1 ? Fragment : AnimatedProgress} color=${color} />
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
export const JsSlide = ({ title, code, notes }) => html`
  <${Slide}>
    <${Heading} fontSize="h3" style=${{ margin: "0" }}>${title}</${Heading}>
    <${CodePane} language="javascript" showLineNumbers=${true} >${code}</${CodePane}>
    <${MdNotes} notes=${notes} />
  </${Slide}>
`;

export const TopicSlide = ({
  backgroundUrl,
  fontSize = "8em",
  children,
  ...rest
}) => html`
  <${Slide}
    ...${
      backgroundUrl
        ? {
            backgroundImage: `url(${backgroundUrl})`,
            backgroundOpacity: 0.4,
            backgroundColor: colors.basics.black,
          }
        : {}
    }
    ...${rest}
  >
    <${FlexBox} height="100%" flexDirection="column" alignSelf="center" justifyContent="center" alignItems="center">
      <${Heading} fontSize=${fontSize} color="primary">
        ${children}
      </${Heading}>
    </${FlexBox}>
  </${Slide}>
`;

// Code editor component
export const CodeEditor = ({ code }) => html`
  <${LiveProvider}
    code=${code}
    language="javascript"
    theme=${themes.vsDark}
  >
    <div className="code-editor-container">
      <${LiveEditor}
        className="react-live-editor"
        style=${{
          minHeight: "400px",
          maxHeight: "400px",
        }}
      />
      <${LiveError}
        className="react-live-error"
      />
      <${LivePreview}
        className="react-live-preview"
        style=${{
          minHeight: "50px",
          maxHeight: "50px",
        }}
      />
    </div>
  </${LiveProvider}>
`;

export const BOX_STYLES = {
  border: "1px solid #fff",
  borderRadius: "8px",
  padding: "0px",
  justifyContent: "center",
  alignItems: "center",
};

// Case slide component
export const CaseSlide = ({ title, sections = [], notes }) => {
  // Calculate grid layout based on sections
  const maxItems = Math.max(
    ...sections.map((section) => Math.max(section.items.length, 1)),
    1,
  );
  const gridRows = `repeat(${sections.length}, 1fr)`;
  const gridColumns = `repeat(${maxItems + 1}, 1fr)`;

  return html`
    <${Slide}>
      <${Heading}>${title}</${Heading}>
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
                <${FlexBox}
                  ...${BOX_STYLES}
                  height="100%"
                >
                  <${Text} color="quaternary" fontSize="2.5em">
                    ${section.title}
                  </${Text}>
                </${FlexBox}>

                <!-- Section content cells -->
                ${section.items.map((item, i) => {
                  // Handle both string items and { icon, text } objects
                  const itemText = typeof item === "string" ? item : item.text;
                  const itemIcon =
                    typeof item === "object" && item.icon ? item.icon : null;
                  const itemIconColor =
                    itemIcon && item.color ? item.color : colors.blue[30];

                  return html`
                    <${FlexBox} key=${i} ...${BOX_STYLES}>
                      <${Text} color="primary" fontSize="1.8em">
                        <${FlexBox}>
                          <${Box} marginRight="0.5em">
                            ${
                              itemIcon
                                ? html`<${Icon}
                                    name=${itemIcon}
                                    fill=${true}
                                    color=${itemIconColor}
                                    style=${{ fontSize: "2em" }}
                                  />`
                                : null
                            }
                          </${Box}>
                          <${Box} style=${{ textAlign: "left" }}>
                            ${itemText}
                          </${Box}>
                        </${FlexBox}>
                      </${Text}>
                    </${Box}>
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
