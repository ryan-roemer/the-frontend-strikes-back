import { createElement, useEffect, useRef } from "react";
import htm from "htm";
import { renderMarkdown } from "../agent/markdown.js";

const html = htm.bind(createElement);

/** One bubble. Markdown is rendered from pre-escaped HTML -- see markdown.js. */
const Bubble = ({ role, text, stopped, receipts }) => html`
  <div
    className=${`chat-bubble chat-bubble--${role}${stopped ? " chat-bubble--stopped" : ""}`}
  >
    <div
      className="chat-bubble__text"
      dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}
    ></div>
    ${stopped ? html`<span className="chat-bubble__flag">stopped</span>` : null}
    ${receipts?.length
      ? html`<ul className="chat-receipts">
          ${receipts.map(
            (receipt, i) =>
              html`<li className="chat-receipts__row" key=${i}>
                <i className="ph ph-check" aria-hidden="true"></i>
                <span>${receipt.label}</span>
              </li>`,
          )}
        <//>`
      : null}
  </div>
`;

/** Three dots, shown only while waiting for the first token. */
const Typing = () => html`
  <div className="chat-bubble chat-bubble--assistant chat-typing">
    <span></span><span></span><span></span>
  </div>
`;

/**
 * The message list.
 *
 * Autoscroll is the sentinel-div trick: an empty node at the end of the list plus
 * `scrollIntoView` in an effect. Both reference repos land on this, and one of
 * them has it in its activity log but NOT in its chat panel -- so the chat there
 * silently stops following a long answer. Keyed on the streaming text as well as
 * the entry count so it also follows mid-answer, not just between turns.
 */
export const Transcript = ({ entries, streaming, busy, error, empty }) => {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entries.length, streaming]);

  const showEmpty = !entries.length && !streaming && !busy;

  return html`
    <div className="chat-transcript">
      ${showEmpty ? empty : null}
      ${entries.map((entry, i) => html`<${Bubble} key=${i} ...${entry} />`)}
      ${streaming
        ? html`<${Bubble} role="assistant" text=${streaming} />`
        : null}
      ${busy && !streaming ? html`<${Typing} />` : null}
      ${error
        ? html`<div className="chat-error" role="alert">
            <i className="ph-fill ph-warning-circle" aria-hidden="true"></i>
            <span>${error}</span>
          </div>`
        : null}
      <div ref=${endRef}></div>
    </div>
  `;
};
