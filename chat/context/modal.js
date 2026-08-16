/* global document:false, getSelection:false, navigator:false, setTimeout:false */
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import htm from "htm";
import { hideContext } from "./state.js";

const html = htm.bind(createElement);

/**
 * Everything that went into one answer.
 *
 * WHAT THIS IS NOT is the more useful half of the description: it is not the string
 * the model read. Neither provider ever builds one in JS. LiteRT hands
 * `createConversation` a `{ preface: { messages } }` array and the runtime folds it
 * into Gemma's turn template on the far side of the wasm boundary; Chrome takes
 * `initialPrompts` and does the same inside the browser process. So what is shown
 * here is the INGREDIENTS -- the system preface, the prior turns, and the question --
 * captured at the moment of sending, which is the most honest thing available and
 * the thing anyone asking the question actually wants to see.
 *
 * It matters that these are the ingredients as the PROVIDER had them, not as the
 * panel shows them. The two disagree on purpose: LiteRT sends at most three previous
 * exchanges, so a long conversation on screen is a short one in the model, and that
 * gap is the explanation for half of the surprising answers a small model gives.
 *
 * Lazily loaded; see `gate.js`. Default export because `lazy()` requires one.
 */

const PROVIDERS = { litert: "LiteRT-LM", chrome: "Chrome Prompt API" };

const ROLES = { system: "System", user: "User", assistant: "Assistant" };

/** Characters, not tokens. A token count would have to come from the runtime, and
 *  asking it now would answer for the context it holds NOW, not the one shown. */
const size = (context) =>
  [context.system, ...context.history.map((m) => m.content), context.message]
    .join("")
    .length.toLocaleString();

/** One labelled block: who said it, and what they said. */
const Message = ({ role, content, note }) => html`
  <div className=${`chat-context__message chat-context__message--${role}`}>
    <div className="chat-context__role">
      ${ROLES[role] ?? role}
      ${note && html`<span className="chat-context__note">${note}</span>`}
    </div>
    <pre className="chat-context__body">${content}</pre>
  </div>
`;

const ContextModal = ({ context }) => {
  const sheet = useRef(null);
  const body = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => sheet.current?.focus(), []);

  /** Escape closes, and arrows are kept off the deck -- as `chat/ui/panel.js`. */
  const onKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      hideContext();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.stopPropagation();
    }
  }, []);

  /** Copy, or failing that select -- see the same note in `chat/tools/modal.js`. */
  const copy = useCallback(async () => {
    const text = [
      `[${ROLES.system}]\n${context.system}`,
      ...context.history.map(
        (m) => `[${ROLES[m.role] ?? m.role}]\n${m.content}`,
      ),
      `[${ROLES.user}]\n${context.message}`,
    ].join("\n\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const node = body.current;
      if (!node) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [context]);

  // History arrives as a flat message list; a person counts it in question-and-
  // answer pairs, and so does the provider's own limit.
  const exchanges = Math.floor(context.history.length / 2);

  const dropped =
    context.historyLimit != null &&
    context.history.length >= context.historyLimit;

  return html`
    <div
      ref=${sheet}
      className="chat-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Context sent to the model"
      tabindex=${-1}
      onKeyDown=${onKeyDown}
      onMouseDown=${(event) => {
        if (event.target === event.currentTarget) hideContext();
      }}
    >
      <div className="chat-sheet__card chat-sheet__card--narrow">
        <header className="chat-sheet__bar">
          <span className="chat-sheet__title">
            <i className="ph-fill ph-brackets-curly" aria-hidden="true"></i>
            Context sent
          </span>
          <span className="chat-sheet__badges">
            <span className="chat-sheet__badge"
              >${PROVIDERS[context.provider] ?? context.provider}</span
            >
            ${
              "" /* Built as one string rather than interpolated around the text:
                    htm collapses the whitespace between an expression and the
                    word after it when they land on different source lines, which
                    reads as "0 priorexchanges". */
            }
            <span
              >${`${exchanges} prior ${exchanges === 1 ? "exchange" : "exchanges"}`}</span
            >
            <span>${size(context)} chars</span>
          </span>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${copy}
            title=${copied ? "Copied" : "Copy the whole context"}
            aria-label=${copied ? "Copied" : "Copy the whole context"}
          >
            <i
              className=${`ph ph-${copied ? "check" : "copy"}`}
              aria-hidden="true"
            ></i>
          </button>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${hideContext}
            title="Close"
            aria-label="Close"
          >
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </header>

        <div className="chat-context__body-scroll" ref=${body}>
          <${Message} role="system" content=${context.system} />
          ${context.history.map(
            (message, i) =>
              html`<${Message}
                key=${i}
                role=${message.role}
                content=${message.content}
              />`,
          )}
          <${Message}
            role="user"
            content=${context.message}
            note="this question"
          />
        </div>

        ${
          "" /* Two footnotes, and both exist because a reader who does not know them
                will misread what is above. The first is the wasm boundary; the second
                is why a panel showing six exchanges can be a model shown three. */
        }
        <footer className="chat-context__foot">
          The runtime wraps these in the model's own turn template before
          decoding, so the final string is never a value this page can
          read.${dropped
            ? html` Older exchanges are dropped: this provider keeps the last
              ${context.historyLimit / 2} and no more.`
            : null}
        </footer>
      </div>
    </div>
  `;
};

export default ContextModal;
