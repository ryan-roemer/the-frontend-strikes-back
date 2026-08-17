/**
 * The smallest observable value, because this repo needed five of them.
 *
 * `chat/state.js`, `chat/tools/state.js`, `chat/context/state.js`, `chat/bus.js` and
 * `chat/agent/model-state.js` each had the identical `const listeners = new Set()`, the
 * identical `subscribe` returning an unsubscribe, and the identical
 * `for (const fn of listeners) fn(value)` notify loop. The plumbing was never the
 * interesting part of any of them -- what each one holds, and why it is separate from
 * the others, is -- so it lives here once and those files keep their reasoning.
 *
 * SHAPED FOR `useSyncExternalStore`. `get` is a snapshot React can compare by reference,
 * so a `set` to an equal value must not produce a new one: `Object.is` guards it. Holders
 * of objects (`bus.js`, `model-state.js`) replace the whole object on every change, which
 * is what makes that comparison meaningful rather than a same-reference trap.
 *
 * @param {*} initial
 * @returns {{ get: () => *, set: (next: *) => void, subscribe: (fn) => () => void }}
 */
export const createStore = (initial) => {
  let value = initial;
  const listeners = new Set();

  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of listeners) fn(value);
    },
    /** Publish without a value change -- for holders that mutate in place. */
    notify: () => {
      for (const fn of listeners) fn(value);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
};
