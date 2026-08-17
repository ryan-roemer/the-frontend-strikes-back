import { createElement, useContext, useEffect, useRef } from "react";
import htm from "htm";
import { DeckContext } from "spectacle";
import { publish } from "./bus.js";

const html = htm.bind(createElement);

/**
 * The only hook-using code inside the deck's React tree, and the only reason
 * `chat/` needs a line in `Template`.
 *
 * MUST be used as an ELEMENT -- `html`<${DeckBridge} />`` -- and never called as
 * a function. Spectacle 10.2.3 invokes the `template` prop as a plain function
 * during `Deck`'s own render:
 *
 *   const templateElement = typeof template === "function"
 *     ? template({ slideNumber, numberOfSlides }) : template;
 *
 * so a hook written directly in `Template` becomes one of DECK's hooks -- and the moment
 * `Template` returns early for any slide, the hook count changes and React throws
 * "rendered fewer hooks than expected", taking the whole deck with it. As an element this
 * gets its own fiber and hook list, reconciled inside `DeckContext.Provider`, so the
 * context is genuinely available here.
 *
 * It renders a hidden marker rather than `null` for one reason: the marker's
 * `parentElement` IS Spectacle's `TemplateWrapper`, which is a sibling of the
 * slides inside the portal. Knowing which child of the portal is the template
 * is what lets the chat map the remaining children onto slide indices.
 */
/**
 * Which mounted bridge is allowed to publish.
 *
 * THE TEMPLATE IS NOT ALWAYS RENDERED ONCE. Overview mode renders it per slide, so this
 * component mounts 35 times and every instance publishes to the same bus -- leaving the
 * snapshot describing whichever copy rendered last, with a `templateWrapperNode` belonging
 * to an arbitrary slide.
 *
 * First mount wins and keeps winning until it unmounts. The `isConnected` check
 * matters for the remount case: the outgoing owner's cleanup can run after the
 * replacement has already mounted, so ownership has to be reclaimable from a node
 * that has left the document.
 */
let owner = null;

export const DeckBridge = () => {
  const deck = useContext(DeckContext);
  const marker = useRef(null);
  const lastSignature = useRef("");

  useEffect(() => {
    if (!deck) {
      // Only reachable if someone moves the bridge out of the Deck subtree.
      // Warn rather than throw: a broken chat must not break the talk.
      //
      // BEFORE THE CLAIM, not after. A bridge that cannot publish must not become the
      // owner: it would hold the slot for as long as its node stayed in the document, and
      // the `isConnected` check below would then lock out every bridge that COULD publish.
      // One misplaced element would silently stop the chat from ever seeing the deck.
      console.warn("[chat] DeckBridge rendered outside DeckContext");
      return;
    }

    if (owner && owner !== marker.current && owner.isConnected) return;
    owner = marker.current;

    const { activeView, slideCount, inOverviewMode, inPrintMode } = deck;

    // The bridge re-renders whenever the Deck does. Most of those renders carry
    // no news for the chat, and each publish fans out to every subscriber, so
    // compare a cheap signature first.
    const signature = [
      activeView?.slideIndex,
      activeView?.stepIndex,
      slideCount,
      inOverviewMode,
      inPrintMode,
      !!deck.slidePortalNode,
    ].join(":");
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;

    publish({
      ready: true,
      templateWrapperNode: marker.current?.parentElement ?? null,
      slidePortalNode: deck.slidePortalNode,
      activeView: deck.activeView,
      slideCount: deck.slideCount,
      slideIds: deck.slideIds,
      inOverviewMode: deck.inOverviewMode,
      inPrintMode: deck.inPrintMode,
      nav: {
        skipTo: deck.skipTo,
        stepForward: deck.stepForward,
        stepBackward: deck.stepBackward,
        advanceSlide: deck.advanceSlide,
        regressSlide: deck.regressSlide,
      },
    });
  }, [deck]);

  // Unmount is a separate effect so it does not fire on every `deck` change.
  // Overview and presenter mode swap the whole View subtree, which unmounts the
  // bridge -- the chat needs to know that its nav callbacks went stale.
  useEffect(
    () => () => {
      // Only the publishing instance may retract. Otherwise the 34 extra copies
      // overview mode creates would each announce the deck as gone on their way
      // out, and the chat would lose its nav callbacks while the deck is fine.
      if (owner !== marker.current) return;
      owner = null;
      lastSignature.current = "";
      publish({ ready: false, nav: null });
    },
    [],
  );

  return html`<div ref=${marker} data-chat-bridge hidden aria-hidden="true" />`;
};
