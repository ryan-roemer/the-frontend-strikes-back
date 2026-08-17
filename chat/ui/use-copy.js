import { useCallback, useEffect, useRef, useState } from "react";

/** How long the button says "copied" before going back to saying "copy". */
const CONFIRM_MS = 1500;

/**
 * Copy some text, or failing that select it.
 *
 * `writeText` rejects outright when the document is not focused -- which is the state a
 * deck is often in, driven from a remote, a second screen or a devtools window.
 * Unhandled, that is a rejected promise and a button that does nothing. Selecting the
 * fallback node instead leaves the room one Cmd-C from the same outcome, and is visible
 * enough to explain itself.
 *
 * THE CONFIRMATION TIMER IS CLEARED ON UNMOUNT. Both callers are sheets that Escape or a
 * scrim click dismisses, and both are one keystroke from being gone while the 1.5s timer
 * is still pending -- a `setState` on an unmounted component every time somebody copies
 * and closes.
 *
 * @param {() => string} getText   Built lazily: the callers assemble theirs from props.
 * @param {object} fallbackRef     A node to select when the clipboard refuses.
 * @returns {{ copied: boolean, copy: () => Promise<void> }}
 */
export const useCopy = (getText, fallbackRef) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    const text = getText();
    if (text == null) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    } catch {
      const node = fallbackRef.current;
      if (!node) return;
      // `getSelection()` is null in a document with no browsing context, and this is
      // already the path where the first choice failed -- throwing here would turn a
      // silent button into an unhandled rejection and still not copy anything.
      const selection = window.getSelection?.();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [getText, fallbackRef]);

  return { copied, copy };
};
