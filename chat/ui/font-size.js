import { createElement, useSyncExternalStore } from "react";
import htm from "htm";
import {
  canGrow,
  canShrink,
  fontScaleStore,
  grow,
  scaleOf,
  shrink,
} from "../font-scale.js";

const html = htm.bind(createElement);

/**
 * Smaller / bigger text, as two small buttons. Used in the panel bar and in both sheet
 * bars, and all three drive the same store -- see `chat/font-scale.js`.
 *
 * The current size lives in the tooltip rather than on screen. Showing it would mean one
 * more thing in a bar that already sheds controls to fit.
 */
export const FontSize = () => {
  const i = useSyncExternalStore(fontScaleStore.subscribe, fontScaleStore.get);
  const pct = `${Math.round(scaleOf(i) * 100)}%`;

  return html`<span
    className="chat-font-size"
    role="group"
    aria-label="Text size"
  >
    <button
      type="button"
      className="chat-icon-button chat-font-size__button"
      onClick=${shrink}
      disabled=${!canShrink(i)}
      title=${`Smaller text (now ${pct})`}
      aria-label="Smaller text"
    >
      <i className="ph ph-minus" aria-hidden="true"></i>
    </button>
    <button
      type="button"
      className="chat-icon-button chat-font-size__button"
      onClick=${grow}
      disabled=${!canGrow(i)}
      title=${`Bigger text (now ${pct})`}
      aria-label="Bigger text"
    >
      <i className="ph ph-plus" aria-hidden="true"></i>
    </button>
  </span>`;
};
