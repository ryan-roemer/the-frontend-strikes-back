import { createElement, useEffect, useRef } from "react";
import htm from "htm";
import { renderMarkdown } from "../agent/markdown.js";
import { showContext } from "../context/state.js";

const html = htm.bind(createElement);

/**
 * One bubble. Markdown is rendered from pre-escaped HTML -- see markdown.js.
 *
 * `prompt` is present only on assistant entries whose turn actually reached the
 * model, so the button is its own answer to "is there anything to show" and needs
 * no separate flag. It is rendered rather than revealed on hover deliberately: a
 * control nobody can see until the pointer is on it does not exist to a room
 * watching a projector.
 */
const Bubble = ({ role, text, stopped, prompt }) => html`
  <div
    className=${`chat-bubble chat-bubble--${role}${stopped ? " chat-bubble--stopped" : ""}`}
  >
    <div
      className="chat-bubble__text"
      dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}
    ></div>
    ${stopped ? html`<span className="chat-bubble__flag">stopped</span>` : null}
    ${prompt
      ? html`<button
          type="button"
          className="chat-bubble__context"
          onClick=${() => showContext(prompt)}
          title="Show the context sent to the model"
          aria-label="Show the context sent to the model"
        >
          <i className="ph ph-brackets-curly" aria-hidden="true"></i>
        </button>`
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
