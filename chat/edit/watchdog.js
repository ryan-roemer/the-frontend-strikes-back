/* global MutationObserver:false, requestAnimationFrame:false */
import { subscribe as subscribeDeck } from "../bus.js";
import { rebuild } from "./patches.js";

/**
 * Re-apply edits after the deck rebuilds itself underneath them.
 *
 * Scope note, so this does not grow into something it should not be: with all
 * styling carried by the chat's own stylesheet and text edits limited to
 * `nodeValue`, almost nothing needs re-applying. React only rewrites what its own
 * props changed, and this deck's slide content is static. This watchdog exists for
 * ONE event class: a full remount, which `mod+shift+P` / `O` / `R` / `E` cause by
 * swapping the entire view subtree. It is not a general DOM-diff engine.
 *
 * `childList` ONLY. `attributes` would fire on our own `classList` writes and loop,
 * and react-spring rewrites each slide wrapper's `style` attribute every animation
 * frame -- an attribute observer on this subtree is a 60fps event storm carrying no
 * information we want.
 */

let observer = null;
let unsubscribe = null;
let queued = false;
let applying = false;

const schedule = () => {
  if (applying || queued) return;
  queued = true;
  // Coalesce: a remount fires many childList records in one frame, and each one
  // would otherwise trigger a full restore-and-replay.
  requestAnimationFrame(() => {
    queued = false;
    applying = true;
    try {
      rebuild();
    } finally {
      // Discard the records our own rebuild just produced, so it does not
      // re-trigger itself.
      observer?.takeRecords();
      applying = false;
    }
  });
};

export const start = () => {
  if (observer) return;
  observer = new MutationObserver(schedule);

  unsubscribe = subscribeDeck(({ slidePortalNode, activeView }) => {
    if (slidePortalNode) {
      // Re-observe rather than assume: the portal node itself is replaced when the
      // deck remounts, and an observer pointed at the old one sees nothing.
      observer.disconnect();
      observer.observe(slidePortalNode, { childList: true, subtree: true });
    }
    // Navigation is the other trigger. `Template`'s own output genuinely IS
    // rewritten by React on every slide change -- the counter's text and the
    // progress bar's width both change, and styled-components hands the progress
    // fill a new generated class -- so anything patched in the chrome needs
    // re-applying even though the slides themselves do not.
    if (activeView) schedule();
  });
};

export const stop = () => {
  observer?.disconnect();
  observer = null;
  unsubscribe?.();
  unsubscribe = null;
};
