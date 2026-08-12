import { createElement } from "react";
import htm from "htm";
import { STATES } from "../agent/model-state.js";

const html = htm.bind(createElement);

/**
 * What the panel says when there is no model to talk to.
 *
 * The brief asked for detection plus a message, and the message has to be
 * actionable rather than an apology -- this is a talk ABOUT the agent-ready
 * browser, so "it doesn't work here" is a claim the audience will read as being
 * about the platform. Says which of the two failures it is, and what would fix
 * it.
 *
 * Everything else in the panel keeps working: the transcript stays readable and
 * the deck is untouched.
 */
export const Unavailable = ({ status, error }) => {
  const unsupported = status === STATES.UNSUPPORTED;

  return html`
    <div className="chat-unavailable">
      <p className="chat-unavailable__lead">
        <i className="ph-fill ph-plugs" aria-hidden="true"></i>
        ${unsupported
          ? "This browser has no Prompt API."
          : "The on-device model can't run here."}
      </p>
      ${unsupported
        ? html`<ul>
            <li>
              Needs Chrome with built-in AI (the
              <code>LanguageModel</code> global is missing entirely).
            </li>
            <li>
              Check <code>chrome://on-device-internals</code> for model status.
            </li>
          </ul>`
        : html`<ul>
            <li>
              The API is present but <code>availability()</code> reports the
              model as unusable — usually free disk space, GPU, or an
              unsupported platform.
            </li>
            <li>
              Check <code>chrome://on-device-internals</code> for the reason.
            </li>
          </ul>`}
      ${error
        ? html`<p className="chat-unavailable__error">${error}</p>`
        : null}
    </div>
  `;
};
