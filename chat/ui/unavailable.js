import { createElement } from "react";
import htm from "htm";
import { unavailableCopy } from "../agent/model-state.js";

const html = htm.bind(createElement);

/**
 * What the panel says when the ACTIVE provider has no model to talk to.
 *
 * The copy comes from the provider rather than from here, because the two fail for entirely
 * unrelated reasons and a message that covers both covers neither. LiteRT fails on WebGPU --
 * and the most common cause on a presenting machine is not an old browser, it is serving the
 * deck from a LAN IP, because `navigator.gpu` is absent outside a secure context. Chrome
 * fails because the browser declined to provide a model, which is not something the page can
 * inspect at all.
 *
 * The message has to be actionable rather than an apology. This is a talk ABOUT the
 * agent-ready browser, so "it doesn't work here" reads as a claim about the platform rather
 * than about this laptop. Every provider's copy therefore ends by pointing at the OTHER
 * provider, which is the one piece of advice that always applies now that there are two.
 *
 * `error` carries the specific reason from the probe, which is why the lists stay short: the
 * useful sentence is usually the one underneath them.
 *
 * Everything else in the panel keeps working -- including the switcher, which is the actual
 * way out of this screen.
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
