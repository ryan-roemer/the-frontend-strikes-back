import { createElement, useSyncExternalStore } from "react";
import htm from "htm";

const html = htm.bind(createElement);

/**
 * A button in the deck chrome that flips one boolean.
 *
 * MUST BE RENDERED AS AN ELEMENT, never called as a function: Spectacle calls the
 * `template` prop as a plain function inside `Deck`'s render, so hooks written directly in
 * `Template` join DECK's hook list. See `chat/bridge.js`.
 *
 * EVERY TOGGLE CARRIES `.chat-toggle`, which owns `pointer-events: auto`. Spectacle's
 * `TemplateWrapper` is `pointer-events: none` and nothing in `styles.css` re-enables it, so
 * a class that forgot that rule would render perfectly and ignore every click.
 *
 * Not using `Icon` from `deck/components.js`: that module imports this one, so the cycle
 * would be real. An `<i>` with the Phosphor classes is what `Icon` renders anyway.
 *
 * @param {object}   store      `{ get, subscribe }` -- any of `chat/store.js`'s.
 * @param {Function} onToggle   What the click does.
 * @param {string}   icon       A Phosphor class, e.g. `ph-sparkle`.
 * @param {string}   labelOn    Title and aria-label while on.
 * @param {string}   labelOff   ...and while off.
 * @param {string}   [modifier] An extra class, for anything that needs its own hook.
 */
export const Toggle = ({
  store,
  onToggle,
  icon,
  labelOn,
  labelOff,
  modifier = "",
}) => {
  const on = useSyncExternalStore(store.subscribe, store.get);
  const label = on ? labelOn : labelOff;

  return html`<button
    type="button"
    className=${`chat-toggle${modifier ? ` ${modifier}` : ""}${on ? " chat-toggle--on" : ""}`}
    onClick=${onToggle}
    aria-pressed=${on}
    title=${label}
    aria-label=${label}
  >
    <i className=${`ph-fill ${icon}`} aria-hidden="true"></i>
  </button>`;
};
