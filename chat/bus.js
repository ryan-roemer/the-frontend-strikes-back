/**
 * The seam between the deck's React tree and the chat's.
 *
 * The chat mounts on its own `createRoot` outside the `Deck`, so it cannot reach
 * Spectacle's context by ordinary means. `DeckBridge` renders INSIDE the deck
 * tree and pushes what it sees through here; everything in `chat/` reads the
 * deck through this module and never touches `DeckContext` itself.
 *
 * No React and no DOM in this file on purpose. It is the one module both roots
 * import, so it has to be safe to import from either side -- and keeping it
 * dependency-free is what makes the two-root architecture cheap to delete.
 *
 * Every publish REPLACES the snapshot object rather than mutating it. That is
 * not stylistic: `useSyncExternalStore` compares `getSnapshot()` by identity, so
 * a mutated-in-place object looks unchanged and the panel silently stops
 * re-rendering. The bridge only publishes when something it cares about actually
 * changed, so the allocation happens roughly once per navigation.
 */

import { createStore } from "./store.js";

const INITIAL = {
  /** False until `DeckBridge` mounts, and again after it unmounts. */
  ready: false,
  /** `{ slideIndex, stepIndex, slideId }`, zero-based, straight from Spectacle. */
  activeView: null,
  slideCount: 0,
  slideIds: [],
  /** The element every slide is portaled into. The only reliable deck-DOM root. */
  slidePortalNode: null,
  /** `TemplateWrapper`, identified via the bridge's marker. Excluded when
   *  mapping portal children onto slide indices. */
  templateWrapperNode: null,
  inOverviewMode: false,
  inPrintMode: false,
  /** Spectacle's own navigation callbacks. Null whenever `ready` is false. */
  nav: null,
};

const store = createStore(INITIAL);

export const getSnapshot = store.get;
export const subscribe = store.subscribe;

/**
 * Merge a partial update and notify.
 *
 * A merge rather than a replace of the whole shape, so the bridge can publish
 * `{ activeView }` on a navigation without restating the portal nodes -- and so
 * `{ ready: false }` on unmount leaves the last known nodes readable. The
 * watchdog still needs a portal node to observe while the deck is remounting,
 * which is exactly when `ready` is false.
 *
 * The merge always produces a NEW object, which is what lets `useDeck()` read this
 * through `useSyncExternalStore` -- the snapshot changes identity exactly when the
 * deck does.
 */
export const publish = (patch) => store.set({ ...store.get(), ...patch });
