import { useSyncExternalStore } from "react";
import { getState, subscribe } from "../agent/model-state.js";

/**
 * The model state machine, as a React snapshot.
 *
 * `useSyncExternalStore` RATHER THAN `useState` + `useEffect`, and the difference is not
 * stylistic. The obvious shape -- `useState(getState)` then `useEffect(() => subscribe(setState))`
 * -- reads the store during render and only starts listening after the commit, so anything
 * published in that gap is lost. That gap is not theoretical here: `chat/index.js` calls
 * `refresh()` at mount, which is exactly when the panel is first rendering, and a missed
 * publish leaves the status icon showing whatever it happened to read first until the next
 * unrelated transition repaints it.
 *
 * `getState` is safe as a snapshot because `set()` in `model-state.js` replaces the state
 * object wholesale, so the reference is stable between publishes and React can compare it.
 *
 * One hook, three consumers -- the panel, the status icon and the provider switch all had
 * their own copy of the broken version.
 */
export const useModelState = () => useSyncExternalStore(subscribe, getState);
