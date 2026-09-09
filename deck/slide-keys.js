/**
 * Shift + arrow: one whole slide per press, reveals or no reveals.
 *
 * Spectacle's own arrows are STEP navigation -- on a slide with three `Appear`
 * blocks, right is four presses to get off it. That is the right default while
 * presenting and the wrong one while moving around the deck, so Shift is the
 * modifier that says "the slide, not the step". It maps straight onto the two
 * `DeckContext` callbacks Spectacle already exposes for it: `advanceSlide` and
 * `regressSlide`.
 *
 * Backwards lands on the previous slide with its reveals already played, which
 * is `regressSlide()`'s default and matches what a plain left arrow does when it
 * crosses a slide boundary. Coming back to a slide you have shown should look
 * the way you left it.
 *
 * SHIFT IS FREE. Spectacle binds `left`/`right` through mousetrap, which
 * compares the event's modifier list against the binding's -- `right` with Shift
 * held matches nothing, so these presses reach us and nothing else.
 *
 * Out of range takes care of itself: Spectacle cancels a transition to a slide
 * that does not exist, so Shift+Right on the last slide is a no-op rather than a
 * deck pointed at nothing.
 */
import { useContext, useEffect } from "react";
import { DeckContext } from "spectacle";

/**
 * The deck to drive, and how many `SlideKeys` are mounted.
 *
 * Overview mode renders the template once per slide, so this component mounts 35
 * times and every copy sees the same context. The count is what makes the way
 * back safe: 34 unmounting must not clear the deck out from under the one that
 * stays, and React may run the new tree's effects either side of the old tree's
 * cleanups. Whichever order it picks, the last write wins and the count only
 * reaches zero when nothing is mounted.
 */
let deck = null;
let mounted = 0;

/** Text fields keep their own Shift+arrow -- that is select-by-word, not navigation. */
const isTextEntry = (node) =>
  !!node &&
  (node.isContentEditable ||
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT");

const onKeyDown = (event) => {
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;

  const forward = event.key === "ArrowRight";
  if (!forward && event.key !== "ArrowLeft") return;
  if (isTextEntry(event.target) || !deck) return;

  event.preventDefault();
  if (forward) deck.advanceSlide();
  else deck.regressSlide();
};

// Module scope, not `mountChat()`: the arrows are the deck's, and they have to
// work on a page where `chat/` never loaded. The listener is idle until a
// `SlideKeys` element hands it a deck.
window.addEventListener("keydown", onKeyDown);

/**
 * Publishes the deck's navigation callbacks to the listener above.
 *
 * MUST be used as an ELEMENT, never called as a function -- see `DeckBridge` in
 * `chat/bridge.js` for the whole story. Short version: Spectacle calls the
 * `template` prop as a plain function during `Deck`'s own render, so a hook
 * written directly in `Template` joins DECK's hook list and the first navigation
 * takes the deck down.
 */
export const SlideKeys = () => {
  const context = useContext(DeckContext);

  useEffect(() => {
    if (!context) return;

    mounted += 1;
    deck = context;

    return () => {
      mounted -= 1;
      if (mounted === 0) deck = null;
    };
  }, [context]);

  // Nothing to draw. The chrome is `Template`'s job; this element exists only
  // to be somewhere inside `DeckContext` that may legally hold a hook.
  return null;
};
