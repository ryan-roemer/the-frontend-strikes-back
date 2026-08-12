import { createElement } from "react";
import htm from "htm";
import { STATES } from "../agent/model-state.js";

const html = htm.bind(createElement);

/**
 * What the panel says when there is no model to talk to.
 *
 * The message has to be actionable rather than an apology. This is a talk ABOUT
 * the agent-ready browser, so "it doesn't work here" is a claim the audience will
 * read as being about the platform rather than about this laptop -- and it must
 * not name a browser vendor, because running everywhere is the point. The model
 * needs WebGPU and nothing else: no vendor API, no flag, no cross-origin
 * isolation headers.
 *
 * Two failures to tell apart, and the distinction is genuinely useful. UNSUPPORTED
 * means the browser or the page context cannot offer WebGPU at all -- and the most
 * common cause on a presenting machine is not an old browser, it is serving the
 * deck from a LAN IP, because `navigator.gpu` is absent outside a secure context.
 * UNAVAILABLE means WebGPU is there but the adapter is unusable.
 *
 * `error` carries the specific reason from the probe, which is why the lists below
 * stay short: the useful sentence is usually the one underneath them.
 *
 * Everything else in the panel keeps working: the transcript stays readable and the
 * deck is untouched.
 */
export const Unavailable = ({ status, error }) => {
  const unsupported = status === STATES.UNSUPPORTED;

  return html`
    <div className="chat-unavailable">
      <p className="chat-unavailable__lead">
        <i className="ph-fill ph-plugs" aria-hidden="true"></i>
        ${unsupported
          ? "This browser can't run WebGPU."
          : "This device's GPU can't run the model."}
      </p>
      ${unsupported
        ? html`<ul>
            <li>
              The model runs on WebGPU, which is available in current Chrome,
              Edge, Safari and Firefox on the desktop.
            </li>
            <li>
              It also needs a secure context. Serving the deck from
              <code>localhost</code> or <code>https</code> works; a bare LAN
              address does not.
            </li>
          </ul>`
        : html`<ul>
            <li>
              WebGPU is present, but no usable GPU adapter came back — a
              software fallback adapter is too slow to run a 2 B-parameter
              model.
            </li>
            <li>Check that hardware acceleration is enabled.</li>
          </ul>`}
      ${error
        ? html`<p className="chat-unavailable__error">${error}</p>`
        : null}
    </div>
  `;
};
