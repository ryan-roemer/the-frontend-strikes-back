/**
 * Re-apply edits after the deck rebuilds itself underneath them.
 *
 * Recovered from `ef4c47f`. Scope note, so this does not grow into something it
 * should not be: with all styling carried by the deck's own stylesheet and text
 * edits limited to `nodeValue`, almost nothing needs re-applying. React only
 * rewrites what its own props changed, and this deck's slide content is static.
 * This watchdog exists for ONE event class: a full remount, which `mod+shift+P`
 * / `O` / `R` / `E` cause by swapping the entire view subtree. It is not a
 * general DOM-diff engine.
 *
 * `childList` ONLY. `attributes` would fire on our own `classList` and
 * `data-deck-ref` writes and loop, and react-spring rewrites each slide
 * wrapper's `style` attribute every animation frame -- an attribute observer on
 * this subtree is a 60fps event storm carrying no information we want.
 */
import { getSnapshot, subscribe } from "../bus.js";
import { rebuild } from "./patches.js";

let observer = null;
let unsubscribe = null;
let queued = false;
let applying = false;

const schedule = () => {
  if (queued || applying) return;
  queued = true;
  // Coalesce: a remount fires many childList records in one frame, and each one
  // would otherwise trigger a full restore-and-replay.
  requestAnimationFrame(() => {
    queued = false;
    // A frame can pass between scheduling and running, and `stop()` can land in
    // it. Rebuilding the deck after the watchdog has been torn down is the exact
    // thing teardown exists to prevent.
    if (!unsubscribe) return;
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

const observe = () => {
  const { slidePortalNode } = getSnapshot();
  if (!slidePortalNode) return;

  // Re-observe rather than assume: the portal node itself is replaced when the
  // deck remounts, and an observer pointed at the old one sees nothing.
  observer?.disconnect();
  observer = observer ?? new MutationObserver(schedule);
  observer.observe(slidePortalNode, { childList: true, subtree: true });
};

export const start = () => {
  if (unsubscribe) return () => {};
  observe();
  unsubscribe = subscribe(observe);
  return stop;
};

export const stop = () => {
  observer?.disconnect();
  observer = null;
  unsubscribe?.();
  unsubscribe = null;
  // Reset the coalescing flags too. `applying` left true would make a restarted
  // watchdog ignore every mutation forever.
  queued = false;
  applying = false;
};
