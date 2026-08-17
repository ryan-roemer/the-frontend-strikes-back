import { createElement, useCallback } from "react";
import htm from "htm";
import { switchProvider } from "../agent/model-state.js";
import { useModelState } from "./use-model-state.js";

const html = htm.bind(createElement);

/**
 * Which runtime is answering, as two pills.
 *
 * The whole demo, in one control. Everything else in this panel is deliberately identical
 * across the two providers -- same transcript, same composer, same state icons -- so that
 * flipping this is the only variable, and the audience can see what actually changes: the
 * download row appears or vanishes, the delete button comes and goes, the context meter
 * switches from a cached sample to an exact count.
 *
 * IT MUST STAY CLICKABLE IN EVERY STATE, including CREATING.
 *
 * This is the escape hatch from a Chrome `create()` that never resolves -- measured, more
 * than once -- and an escape hatch disabled while the thing it escapes is happening is not
 * one. So there is no `disabled` on the busy path here, only on a provider that genuinely
 * cannot run. `switchProvider()` bumps the load generation, which is what lets it abandon a
 * promise that will never settle rather than waiting for it.
 *
 * Rendered as static text when only one provider is offered. A segmented control with one
 * segment is a button that does nothing, and on a browser with no Prompt API the absent
 * pill is itself the honest report.
 */
export const ProviderSwitch = () => {
  const state = useModelState();

  const onPick = useCallback((id) => switchProvider(id), []);

  const { providers, providerId } = state;
  if (!providers.length) return null;

  if (providers.length === 1) {
    return html`<span className="chat-provider chat-provider--single"
      >${providers[0].label}</span
    >`;
  }

  return html`
    <span
      className="chat-provider"
      role="radiogroup"
      aria-label="On-device model provider"
    >
      ${providers.map(
        (p) => html`
          <button
            key=${p.id}
            type="button"
            role="radio"
            aria-checked=${p.id === providerId}
            className=${`chat-provider__pill${p.id === providerId ? " chat-provider__pill--on" : ""}`}
            onClick=${() => onPick(p.id)}
            title=${`Answer with ${p.label}`}
          >
            ${p.label}
          </button>
        `,
      )}
    </span>
  `;
};
