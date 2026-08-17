/**
 * Moving the deck.
 *
 * The primary path is `chat/bridge.js`, which publishes the very callbacks
 * Spectacle's own keyboard handler uses. `nav` goes null in overview and
 * presenter mode -- both swap the whole View subtree, unmounting the bridge --
 * so every function here reads the bus at CALL time and handles its absence.
 */
import { getSnapshot, subscribe } from "./bus.js";

const clamp = (value, max) => Math.min(Math.max(value, 0), Math.max(0, max));

const currentIndex = () => getSnapshot().activeView?.slideIndex ?? 0;

/**
 * How long to wait for the deck to actually land.
 *
 * Generous: `activeView` updates on the React state change, not at the end of
 * the transition, so this only has to outlast a commit. `?animate=false` makes
 * it instant.
 */
const SETTLE_MS = 500;

/**
 * Wait until the deck reports the move, or give up.
 *
 * SPECTACLE NAVIGATES VIA A REACT STATE UPDATE, so nothing is readable
 * synchronously after a nav call -- the old adapter noted that comparing indices
 * before and after reads the OLD value, and it is why it gave up on detecting
 * success at all and always reported it.
 *
 * Subscribing to the bus is the missing piece it did not have available: the
 * bridge publishes on every navigation, so waiting for that publish turns "I
 * asked it to move" into "it moved, and here is where it is". Two things depend
 * on that being real rather than assumed:
 *
 *   - RECEIPTS. `apply.js` established that a receipt must describe what
 *     happened, not what was requested. "Slide 21" computed from the argument is
 *     exactly the shape of claim that discipline exists to prevent.
 *   - SEQUENCING. An agent calling `go_to_slide` then `get_current_slide` should
 *     see the new slide. Without settling it reads the old one and starts
 *     reasoning about the wrong content.
 *
 * Resolving false on timeout is not a failure to report upward on its own: at
 * either end of the deck Spectacle clamps, so a no-op looks identical to a
 * timeout. The caller compares positions to tell them apart.
 */
const settle = (moved) =>
  new Promise((resolve) => {
    if (moved(getSnapshot())) return resolve(true);

    let timer = null;
    const off = subscribe(() => {
      if (!moved(getSnapshot())) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
    timer = setTimeout(() => {
      off();
      resolve(false);
    }, SETTLE_MS);
  });

/** Where the deck is, as one comparable value. */
const viewKey = (snapshot = getSnapshot()) =>
  `${snapshot.activeView?.slideIndex ?? -1}:${snapshot.activeView?.stepIndex ?? -1}`;

/**
 * SPECTACLE'S RELATIVE-NAVIGATION FUNCTIONS RETURN `undefined`, NOT A BOOLEAN.
 *
 * So `!!advanceSlide()` was always false, and the old caller turned every
 * working "next slide" into "I couldn't move the deck" -- the deck advanced and
 * the receipt said it had not. Never read their return value.
 *
 * What comes back from here instead is where the deck ENDED UP: `{ from, to,
 * moved }`, 1-based, measured after the bus reports the change. `moved: false`
 * is a real answer rather than a failure -- Spectacle clamps at both ends, so
 * asking for "next" on slide 35 legitimately does nothing, and saying so is more
 * use than either "done" or "couldn't".
 */
const relative = (fn) => async () => {
  const { nav: deckNav } = getSnapshot();
  if (!deckNav) return null;

  const before = viewKey();
  const from = currentIndex() + 1;
  fn(deckNav);
  await settle((s) => viewKey(s) !== before);

  return { from, to: currentIndex() + 1, moved: viewKey() !== before };
};

export const nav = {
  /** A step if the slide has them, otherwise the next slide. */
  next: relative((d) => d.stepForward()),
  prev: relative((d) => d.stepBackward()),
  /** Past any remaining steps, to the next slide. */
  nextSlide: relative((d) => d.advanceSlide()),
  prevSlide: relative((d) => d.regressSlide()),

  /**
   * Jump to a slide, 1-BASED for the caller's benefit -- everything a person or
   * an agent says about this deck is 1-based, and `activeView.slideIndex` is the
   * only place that is not.
   *
   * ALWAYS SENDS BOTH INDICES. `SKIP_TO` merges into the pending view, so leaving
   * `stepIndex` out carries the PREVIOUS slide's step onto the new slide -- land
   * on a slide with two reveals from one showing three and it opens half-played.
   *
   * ALWAYS CLAMPS. `skipTo` does no bounds checking of its own, and an
   * out-of-range index leaves the deck pointing at no slide at all, which
   * self-cancels and looks exactly like the command being ignored.
   */
  toSlide: async (oneBased) => {
    const { nav: deckNav, slideCount } = getSnapshot();
    if (!deckNav) return null;

    const from = currentIndex() + 1;
    const slideIndex = clamp((oneBased | 0) - 1, (slideCount || 1) - 1);

    deckNav.skipTo({ slideIndex, stepIndex: 0 });
    await settle((s) => s.activeView?.slideIndex === slideIndex);

    // `moved` is "the deck changed position", NOT "we reached the target". They
    // differ when you ask to go where you already are -- `last` on slide 35 --
    // and conflating them made that report as a move. `arrived` is the other
    // question, and `go_to_slide` is the one that cares about it.
    return {
      from,
      to: currentIndex() + 1,
      moved: currentIndex() + 1 !== from,
      arrived: currentIndex() === slideIndex,
      clamped: slideIndex + 1 !== Number(oneBased),
    };
  },

  first: () => nav.toSlide(1),
  last: () => nav.toSlide(getSnapshot().slideCount || 1),

  /** Where the deck is, 1-based, for a receipt. */
  at: () => currentIndex() + 1,
  count: () => getSnapshot().slideCount || 0,
};
