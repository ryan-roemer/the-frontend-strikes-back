/**
 * The backup recording for a live demo: a button in the deck chrome, ⇧⌥V, and a
 * fullscreen muted `<video>` over the slide.
 *
 * LOCALHOST ONLY. The recordings are gitignored (`media/videos/`), so on GitHub
 * Pages there is nothing to play, and the published deck must look exactly as it
 * did. Off localhost, the button renders nothing and the hotkey does nothing.
 *
 * WHICH SLIDE. `DemoSlide` passes its `demo` prop to Spectacle as the slide
 * `id`, and `DeckContext.activeView.slideId` is the id of the slide on screen,
 * so on a demo slide it is the demo id. It is looked up in `deck/demos.js`.
 * Not `SlideContext`: the deck's `Template` renders once, in `Deck`, outside
 * every slide (per slide only in overview and print mode, where the button is
 * hidden anyway).
 *
 * KEYS. While the overlay is up, every key stops at it: Space plays and pauses,
 * the arrows seek, Escape (or ⇧⌥V) closes, and nothing reaches Spectacle's
 * navigation, `slide-keys.js` or `chat/keys.js`. It works like `useDismissKeys`,
 * but for every key: the overlay is portaled to `<body>`, and React's
 * `stopPropagation` there stops the native event before `document` and `window`.
 * CAPTURE PHASE, because once the `<video>` has focus (a click on its controls)
 * Chrome's own media keys run on it first: Space would pause here and play again
 * there, and Up would change the volume. Stopped on the way down, it never gets them.
 *
 * A MISSING FILE is expected: the registry comes first and the recordings
 * later. The button still shows (the slide does have a backup plan), and the
 * overlay says which file to add and how. Nothing else on the slide notices.
 * `npm run offline:check` lists every missing one.
 */
import {
  Fragment,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import htm from "htm";
import { DeckContext, Text } from "spectacle";
import { DEMO_VIDEOS, posterPath, videoPath } from "./demos.js";
import { hint } from "../chat/keys.js";
import { createStore } from "../chat/store.js";
import { Toggle } from "../chat/ui/toggle.js";

const html = htm.bind(createElement);

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const IN_PRESENTER =
  new URLSearchParams(location.search).get("presenterMode") === "true";

export const VIDEO_KEY_HINT = hint("V");

/** How far one arrow press seeks, in seconds. */
const SEEK_S = 5;

/** The id of the demo whose video is open, or null. */
const playing = createStore(null);

/** The id of the demo on screen, if its slide has a video. Set by the button. */
let onScreen = null;

/** `Toggle` wants a boolean store. */
const openStore = {
  get: () => playing.get() !== null,
  subscribe: playing.subscribe,
};

const toggle = () => playing.set(playing.get() ? null : onScreen);
const close = () => playing.set(null);

/** Shift+Alt held, and nothing else, as in `chat/keys.js`. */
const chord = (event) =>
  event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey;

// Module scope, like `slide-keys.js`: it has to work when `chat/` never mounted.
// Only reached while the overlay is closed; the overlay handles its own keys.
if (LOCAL) {
  window.addEventListener("keydown", (event) => {
    if (event.repeat || !chord(event) || event.code !== "KeyV") return;
    if (!onScreen) return;
    event.preventDefault();
    toggle();
  });
}

const Overlay = ({ id }) => {
  const box = useRef(null);
  const video = useRef(null);
  const [missing, setMissing] = useState(false);

  // Focused on open so keys land here. Lowercase `tabindex` below because
  // prettier formats these templates as HTML; see `chat/context/modal.js`.
  //
  // Muted and started here rather than with `muted`/`autoplay` attributes: those
  // would have to be camelCase for React, and React sets `muted` as an attribute
  // only, which autoplay rules ignore. The recordings have no sound anyway. A
  // missing file rejects `play()`; `onError` below already handles that.
  useEffect(() => {
    box.current?.focus();
    const v = video.current;
    if (!v) return;
    v.muted = true;
    v.play().catch(() => {});
  }, []);

  const onKeyDown = (event) => {
    event.stopPropagation();
    const v = video.current;

    if (event.key === "Escape" || (chord(event) && event.code === "KeyV")) {
      event.preventDefault();
      close();
    } else if (event.key === " " && v) {
      event.preventDefault();
      if (v.paused) v.play();
      else v.pause();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && v) {
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -SEEK_S : SEEK_S;
      v.currentTime = Math.max(0, v.currentTime + step);
    } else if (event.key.startsWith("Arrow")) {
      // Up and down: keep the video's native volume keys from acting.
      event.preventDefault();
    }
  };

  return html`<div
    ref=${box}
    className="demo-video"
    role="dialog"
    aria-modal="true"
    aria-label=${`Backup recording: ${DEMO_VIDEOS[id]}`}
    tabindex=${-1}
    onKeyDownCapture=${onKeyDown}
  >
    ${
      missing
        ? html`<div className="demo-video__missing">
            <${Text} fontSize="32px" margin="0px">No recording yet</${Text}>
            <${Text} fontSize="22px" margin="16px 0px 0px">
              <code>${videoPath(id)}</code> is missing. Add it with:
            </${Text}>
            <${Text} fontSize="22px" margin="8px 0px 0px">
              <code>${`npm run video:add -- <file.mov> ${id}`}</code>
            </${Text}>
            <${Text} fontSize="18px" margin="24px 0px 0px">Esc to go back</${Text}>
          </div>`
        : html`<video
            ref=${video}
            className="demo-video__player"
            src=${`./${videoPath(id)}`}
            poster=${`./${posterPath(id)}`}
            controls
            onError=${() => setMissing(true)}
          />`
    }
    <button
      type="button"
      className="chat-toggle demo-video__close"
      onClick=${close}
      title="Close (Esc)"
      aria-label="Close the recording"
    >
      <i className="ph-fill ph-x" aria-hidden="true"></i>
    </button>
  </div>`;
};

/**
 * The button, and the overlay while it is open. Renders nothing unless this
 * slide has a registered video, on localhost, in the normal audience view.
 *
 * MUST be rendered as an ELEMENT inside `Template`, never called: it has hooks.
 * See `SlideKeys` in `slide-keys.js`.
 */
export const VideoToggle = () => {
  const deck = useContext(DeckContext);
  const open = useSyncExternalStore(playing.subscribe, playing.get);
  const slideId = deck?.activeView?.slideId ?? "";

  const id =
    LOCAL &&
    !IN_PRESENTER &&
    !deck?.inOverviewMode &&
    !deck?.inPrintMode &&
    Object.hasOwn(DEMO_VIDEOS, slideId)
      ? slideId
      : null;

  useEffect(() => {
    if (!id) return;
    onScreen = id;
    return () => {
      if (onScreen === id) onScreen = null;
      // Leaving the slide (an agent's `go_to_slide`, say) takes the video down.
      if (playing.get() === id) close();
    };
  }, [id]);

  if (!id) return null;

  return html`<${Fragment}>
    <${Toggle}
      store=${openStore}
      onToggle=${toggle}
      icon="ph-film-strip"
      labelOn=${`Close the backup recording (${VIDEO_KEY_HINT})`}
      labelOff=${`Play the backup recording (${VIDEO_KEY_HINT})`}
      modifier="chat-toggle--video"
    />
    ${open === id && createPortal(html`<${Overlay} id=${id} />`, document.body)}
  <//>`;
};
