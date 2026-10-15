/**
 * The Spectacle banner: a button in the deck chrome, ⇧⌥S, and a card over the
 * slide with the logo and nearform.com/open-source.
 *
 * IN THE CHROME, NOT ON A SLIDE. It used to be a logo inline in a sentence, and
 * then a step on the bonus demo slide. Both tied it to one slide and one beat of
 * the talk. Next to the sparkle and the plug it is there on every slide, for
 * whenever Spectacle comes up, or not at all.
 *
 * PORTALED TO `<body>`, like the chat panel and for the same reason: Spectacle
 * portals every slide into an aspect-fit box carrying `transform: scale()` and
 * `overflow: hidden`. The scrim, the centering and the z-index above the chat
 * panel are `.chat-sheet` from `chat/chat.css`; the card is `.spectacle-card` in
 * `styles.css`.
 *
 * Hidden in presenter, overview and print mode, as `demo-video.js`: the audience
 * window is the one the room sees, and in overview the template renders once per
 * thumbnail, so each would carry its own banner.
 */
import {
  Fragment,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import htm from "htm";
import { DeckContext, Link, SpectacleLogo, Text } from "spectacle";
import { isPaged, SPECTACLE_ROSE } from "./theme.js";
import { images } from "./media.js";
import { hint } from "../chat/keys.js";
import { createStore } from "../chat/store.js";
import { Toggle } from "../chat/ui/toggle.js";
import { useDismissKeys } from "../chat/ui/use-dismiss-keys.js";

const html = htm.bind(createElement);

const IN_PRESENTER =
  new URLSearchParams(location.search).get("presenterMode") === "true";

export const SPECTACLE_KEY_HINT = hint("S");

const store = createStore(false);
const toggle = () => store.set(!store.get());
const close = () => store.set(false);

// Module scope, like `demo-video.js`: it has to work when `chat/` never mounted.
// While the banner is up, focus is on it, and this still hears the chord on its
// way up -- only Escape and the arrows are stopped there.
if (!isPaged && !IN_PRESENTER) {
  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.code !== "KeyS") return;
    if (!event.shiftKey || !event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    toggle();
  });
}

const Banner = () => {
  const sheet = useRef(null);
  /** Escape closes, arrows stay off the deck -- see `use-dismiss-keys.js`. */
  const onKeyDown = useDismissKeys(close);

  // Focused on open so Escape has somewhere to land. Lowercase `tabindex` below
  // because prettier formats these templates as HTML; see `chat/context/modal.js`.
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  return html`<div
    ref=${sheet}
    className="chat-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Spectacle"
    tabindex=${-1}
    onKeyDown=${onKeyDown}
    onClick=${(event) => {
      // Any click closes it, card included, except on the one link: that one
      // opens its tab and leaves the banner up.
      if (!event.target.closest(".spectacle-card__link")) close();
    }}
  >
    <div
      className="spectacle-card"
      style=${{ backgroundImage: `url(${images.spectacle})` }}
    >
      <${SpectacleLogo} size=${280} />
      <${Text} className="spectacle-card__url" margin="0px">
        <${Link}
          className="spectacle-card__link"
          href="https://nearform.com/open-source"
          color=${SPECTACLE_ROSE}
          textDecoration="none"
          target="_blank"
        >
          nearform.com/open-source
        <//>
      <//>
    </div>
  </div>`;
};

/**
 * The button, and the banner while it is open.
 *
 * MUST be rendered as an ELEMENT inside `Template`, never called: it has hooks.
 * See `SlideKeys` in `slide-keys.js`.
 */
export const SpectacleToggle = () => {
  const deck = useContext(DeckContext);
  const open = useSyncExternalStore(store.subscribe, store.get);
  const shown =
    !isPaged && !IN_PRESENTER && !deck?.inOverviewMode && !deck?.inPrintMode;

  if (!shown) return null;

  return html`<${Fragment}>
    <${Toggle}
      store=${store}
      onToggle=${toggle}
      icon="ph-hexagon"
      labelOn=${`Close the Spectacle banner (${SPECTACLE_KEY_HINT})`}
      labelOff=${`Show the Spectacle banner (${SPECTACLE_KEY_HINT})`}
      modifier="chat-toggle--spectacle"
    />
    ${open && createPortal(html`<${Banner} />`, document.body)}
  <//>`;
};
