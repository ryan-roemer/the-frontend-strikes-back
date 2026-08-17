import { useCallback } from "react";

/**
 * Escape closes; left and right never reach the deck.
 *
 * Spectacle binds left/right on `document` through mousetrap, whose `stopCallback`
 * already spares events targeted at a TEXTAREA -- so typing is safe for free. A focused
 * BUTTON inside one of these surfaces is not: arrow keys there would both do nothing
 * visible and silently change slides behind whatever is on top. Escape is handled here
 * rather than globally because each surface closes itself.
 *
 * One hook, three surfaces -- the panel, the context sheet and the tool inspector each
 * had a byte-identical copy of this, and the two later ones carried a comment pointing
 * at the first while repeating the code it described.
 *
 * @param {() => void} onEscape What this surface does when dismissed.
 */
export const useDismissKeys = (onEscape) =>
  useCallback(
    (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.stopPropagation();
      }
    },
    [onEscape],
  );
