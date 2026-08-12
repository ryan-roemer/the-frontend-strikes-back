import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe } from "./bus.js";

/**
 * The deck, as seen from the chat's React tree.
 *
 * `useSyncExternalStore` rather than `useEffect` + `useState` because the bridge
 * can publish before the chat root has finished mounting -- the deck renders
 * first -- and this reads the current value on the first render instead of
 * showing an empty frame and correcting itself.
 */
export const useDeck = () => useSyncExternalStore(subscribe, getSnapshot);
