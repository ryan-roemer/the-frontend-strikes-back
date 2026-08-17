import { createElement, useSyncExternalStore } from "react";
import htm from "htm";

const html = htm.bind(createElement);

/**
 * A button in the deck chrome that flips one boolean.
 *
 * TWO SHARP EDGES, AND BOTH ARE INHERITED RATHER THAN CHOSEN.
 *
 * Hooks are safe here only because every use of this is rendered as an ELEMENT, so it
 * owns its own fiber. Spectacle calls the `template` prop as a plain function inside
 * `Deck`'s render, so a hook written directly in `Template` joins DECK's hook list --
 * see `chat/bridge.js`, which explains what that cost. Never call these as functions.
 *
 * `pointer-events` is the other. Spectacle's `TemplateWrapper` -- the box the whole deck
 * template renders into -- is `pointer-events: none`, and nothing in `styles.css`
 * re-enables it. Spectacle's own `FullScreen` works around this by setting
 * `pointerEvents: "all"` inline; `.chat-toggle` does the same in CSS. That is why every
 * toggle here carries `.chat-toggle` rather than a class of its own: a separate class
 * that forgot the rule would render perfectly and ignore every click.
 *
 * THE BUTTON IS NOT THE THING IT OPENS. All any of these do is flip a boolean; the panel
 * and the sheets render on `#chat-root`, outside the deck's scaled, non-interactive
 * template box. A `position: fixed` scrim inside a `transform`ed ancestor positions
 * against that ancestor rather than the viewport, so a modal rendered here would be
 * pinned to the slide rather than to the screen.
 *
 * Deliberately not using `Icon` from `deck/components.js`: that module imports this one,
 * and the cycle would be real. An `<i>` with the Phosphor classes is what `Icon` renders.
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
