import { createElement } from "react";
import htm from "htm";
import { unavailableCopy } from "../agent/model-state.js";

const html = htm.bind(createElement);

/**
 * What the panel says when the ACTIVE provider has no model to talk to.
 *
 * THE COPY COMES FROM THE PROVIDER, because the two fail for unrelated reasons and a
 * message covering both covers neither. LiteRT fails on WebGPU -- most often because the
 * deck is served from a LAN IP, where `navigator.gpu` is absent outside a secure context.
 * Chrome fails because the browser declined, which the page cannot inspect at all.
 *
 * Every provider's copy ends by pointing at the OTHER provider: this is a talk ABOUT the
 * agent-ready browser, so "it doesn't work here" reads as a claim about the platform
 * rather than about this laptop, and the switcher is the actual way out of this screen.
 *
 * `error` carries the probe's specific reason, which is why the lists stay short.
 */
export const Unavailable = ({ status, error }) => {
  const { lead, bullets } = unavailableCopy(status);

  return html`
    <div className="chat-unavailable">
      <p className="chat-unavailable__lead">
        <i className="ph-fill ph-plugs" aria-hidden="true"></i>
        ${lead}
      </p>
      ${bullets.length
        ? html`<ul>
            ${bullets.map((line, i) => html`<li key=${i}>${line}</li>`)}
          </ul>`
        : null}
      ${error
        ? html`<p className="chat-unavailable__error">${error}</p>`
        : null}
    </div>
  `;
};
