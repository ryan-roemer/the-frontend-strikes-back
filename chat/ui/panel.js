import { createElement, useCallback, useEffect, useRef } from "react";
import htm from "htm";
import { setEnabled } from "../state.js";
import { useConversation } from "../use-conversation.js";
import { useDeck } from "../use-deck.js";
import { refresh, restart } from "../agent/model-state.js";
import { STATES } from "../agent/states.js";
import { respond } from "../agent/act/respond.js";
import { useDismissKeys } from "./use-dismiss-keys.js";
import { useModelState } from "./use-model-state.js";
import { usePanelGeometry } from "./geometry.js";
import { Transcript } from "./transcript.js";
import { Composer } from "./composer.js";
import { ContextUnderline, ModelControls } from "./model-status.js";
import { ProviderSwitch } from "./provider-switch.js";
import { Unavailable } from "./unavailable.js";

const html = htm.bind(createElement);

/**
 * The empty state: the only place the assistant says what it is good at.
 *
 * IT NAMES THE DECK, because a generic "ask it anything" undersells what this model can
 * do and invites a room to ask a 2B model general-knowledge questions it answers badly
 * instead of deck questions it answers well.
 *
 * THE SUGGESTIONS SEND ON CLICK rather than filling the composer -- one tap is the point
 * from a stage. Each exercises a different context source in order: the outline, the
 * current slide, then the argument in the system prompt.
 *
 * The middle one NAMES THE SLIDE from the bus, so it re-reads on every navigation, which
 * is the cheapest proof the thing is watching the deck. It degrades to "this slide" when
 * the bridge is down (overview and presenter mode unmount it) rather than showing a
 * confident wrong slide number.
 */
/** Edges before corners, so a corner handle stacks on top of the two edges it meets. */
const RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const RESIZE_LABELS = {
  n: "Resize from top",
  s: "Resize from bottom",
  e: "Resize from right",
  w: "Resize from left",
  ne: "Resize from top-right",
  nw: "Resize from top-left",
  se: "Resize from bottom-right",
  sw: "Resize from bottom-left",
};

const SUGGESTIONS = (slide) => [
  "What is this talk about?",
  slide ? `Summarize slide ${slide}` : "Summarize this slide",
  "What should I take away from it?",
];

const EmptyState = ({ onSend }) => {
  // Through `useDeck` rather than `views.position()`: this has to RE-RENDER when
  // the deck moves, and a plain snapshot read would only be right until it did.
  const { ready, activeView } = useDeck();
  const slide = ready && activeView ? activeView.slideIndex + 1 : null;

  return html`
    <div className="chat-empty">
      <p>
        Ask me about this presentation or the slide you're on. I'm a small model
        running entirely on this machine.
      </p>
      <ul className="chat-empty__suggestions">
        ${SUGGESTIONS(slide).map(
          (text) => html`
            <li key=${text}>
              <button
                type="button"
                className="chat-empty__suggestion"
                onClick=${() => onSend(text)}
              >
                <i
                  className="ph ph-arrow-elbow-down-left"
                  aria-hidden="true"
                ></i>
                <span>${text}</span>
              </button>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
};

/**
 * The floating window.
 *
 * `hidden` comes from the caller rather than an early return, and that is the
 * whole disable-without-losing-state mechanism: the subtree stays mounted, so the
 * transcript, the scroll position and the model session all survive being closed
 * and reopened.
 */
export const Panel = ({ enabled }) => {
  const model = useModelState();
  const panelRef = useRef(null);
  const { reset, dragHandlers, resizeHandlers } = usePanelGeometry(panelRef);
  // `respond` IS the `respond({ text, onChunk, signal })` contract this hook drives, so
  // there is no adapter between the two. It wraps `streamAnswer` rather than replacing it:
  // a turn that calls no tool is the same single streamed call it always was, and one that
  // does gets its receipt through the same `onChunk`. See `agent/act/respond.js`.
  const { entries, history, streaming, busy, error, send, stop, clear } =
    useConversation(respond);
  const inputRef = useRef(null);

  // Re-check whenever the panel is opened, so a model that finished downloading
  // mid-talk promotes itself without a reload. Cheap: a memoized GPU probe and a
  // Cache API lookup. `refresh()` returns early while a load is in flight, which
  // matters here -- opening the panel mid-download must not offer to start a
  // second 2 GB fetch.
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled]);

  /** Escape closes, arrows stay off the deck -- see `use-dismiss-keys.js`. */
  const close = useCallback(() => setEnabled(false), []);
  const onKeyDown = useDismissKeys(close);

  /**
   * THE TRANSCRIPT FOLLOWS THE MODEL'S MEMORY.
   *
   * One rule, one place. Anything that drops what the model remembers -- the broom, freeing
   * the conversation from the status row, deleting the model -- bumps `epoch`, and the
   * transcript goes with it. Previously each of those had to remember to clear the
   * transcript itself, and freeing the conversation from the status row did not: the window
   * kept showing an exchange the model had no memory of, so "tell me more" resolved against
   * nothing.
   *
   * Guarded on a non-zero epoch so a fresh mount does not count as a drop.
   */
  // Keyed on the epoch ALONE, deliberately. `clear` is stable (`useCallback(…, [])` in
  // `use-conversation.js`), so listing it would change nothing today -- but the rule this
  // effect encodes is "the model forgot", and the epoch is the only expression of that.
  // Adding a dependency that could ever change for another reason would wipe the transcript
  // for that other reason.
  useEffect(() => {
    if (model.epoch) clear();
  }, [model.epoch]);

  /** The broom: empty context, keep talking. `restart()` bumps the epoch, which is what
   *  clears the transcript -- see above. Recreates the conversation because a conversation
   *  owns its history; the difference from the Prompt API is the price, now ~2ms. */
  const newChat = useCallback(() => {
    restart();
  }, []);

  const dead =
    model.status === STATES.UNSUPPORTED || model.status === STATES.UNAVAILABLE;

  /**
   * Opening the panel puts the caret in the composer.
   *
   * Opening the assistant is always followed by typing into it, and without this the
   * Shift+Alt+C chord is an incomplete gesture -- it opens the box and then leaves you
   * reaching for the mouse to click it.
   *
   * NOT SIMPLY KEYED ON `enabled`. On the render that opens the panel the composer is
   * usually still disabled: the panel is closed on load, so the very first open is also
   * the first time the model is asked about, and `dead` is true until that check comes
   * back a tick later. `focus()` on a disabled control is a silent no-op, so an effect
   * that only watched `enabled` did nothing on the one open that matters most.
   *
   * The latch is what keeps this to ONCE PER OPENING. `dead` can flip again later -- a
   * model deleted, a provider switched -- and refocusing then would yank the caret out of
   * whatever the presenter was doing on the slide behind.
   */
  /** The Up arrow is only advertised once there is something to recall: on a panel that
   *  has never been asked anything it is a hint about a feature that would do nothing. */
  const placeholder = dead
    ? "No on-device model available"
    : history.length > 0
      ? "Ask or instruct… (Enter to send, ↑ for past questions)"
      : "Ask or instruct… (Enter to send)";

  const focused = useRef(false);
  useEffect(() => {
    if (!enabled) {
      focused.current = false;
      return;
    }
    if (dead || focused.current) return;
    focused.current = true;
    inputRef.current?.focus();
  }, [dead, enabled]);

  return html`
    <section
      ref=${panelRef}
      className="chat-panel"
      hidden=${!enabled}
      onKeyDown=${onKeyDown}
      aria-label="Deck assistant"
    >
      <header className="chat-panel__bar" ...${dragHandlers}>
        ${
          "" /* Icon only. The window is unmistakably the assistant's, and the bar is
                narrow enough that a title was crowding the controls that matter. */
        }
        <span className="chat-panel__title">
          <i className="ph-fill ph-sparkle" aria-hidden="true"></i>
        </span>
        ${
          "" /* Left-aligned, away from the action group: it is the one control here that
                changes WHAT is answering rather than what happens to it. */
        }
        <${ProviderSwitch} />
        <span className="chat-panel__actions">
          ${
            "" /* The model's own controls, inline. Percent, state, trash, info --
                  see `ModelControls`. They lead the group so the panel's controls
                  (broom, recentre, close) stay in the same order and the same place
                  they have always been, hard right.

                  THE THREE BELOW CARRY A MODIFIER EACH so the container query in
                  `chat.css` can drop them one at a time as the panel narrows. Three
                  identical `.chat-icon-button`s cannot be told apart in CSS by anything
                  except `:nth-child`, which would silently retarget the day one of them
                  moves or `ModelControls` renders a different number of buttons. */
          }
          <${ModelControls} />
          <button
            type="button"
            className="chat-icon-button chat-panel__action--new"
            onClick=${newChat}
            title="New chat (fresh context)"
            aria-label="New chat"
          >
            <i className="ph ph-broom" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            className="chat-icon-button chat-panel__action--reset"
            onClick=${reset}
            title="Reset panel position and size"
            aria-label="Reset panel position and size"
          >
            <i className="ph ph-crosshair" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            className="chat-icon-button chat-panel__action--close"
            onClick=${close}
            title="Close (Esc)"
            aria-label="Close deck assistant"
          >
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </span>
        ${
          "" /* Context usage, underlining the whole bar. Positioned against the bar
                rather than placed in the flow, so it reads as a property of the
                header instead of another control competing for width. */
        }
        <${ContextUnderline} />
      </header>

      ${dead
        ? html`<${Unavailable} status=${model.status} error=${model.error} />`
        : html`<${Transcript}
            entries=${entries}
            streaming=${streaming}
            busy=${busy}
            error=${error}
            empty=${html`<${EmptyState} onSend=${send} />`}
          />`}

      <${Composer}
        onSend=${send}
        onStop=${stop}
        busy=${busy}
        disabled=${dead}
        history=${history}
        inputRef=${inputRef}
        placeholder=${placeholder}
      />

      ${
        "" /* Eight resize handles, one per edge and corner, all on the same gesture
              machinery as the drag bar.

              THE CORNER GRIP ALONE WAS THE WRONG ONE. The panel's home is the
              bottom-right of the viewport, so the south-east corner -- the only handle
              there used to be -- is the one with nowhere to travel, and pulling it
              inward shrinks the window away from the corner it is parked in. The edges
              people reach for on a window sitting there are west and north, and those
              hold the far edge still. See `resize()` in `geometry.js`.

              Only `se` draws anything. Eight visible grips on a small floating window is
              chrome competing with the slide behind it; the cursor changing on approach
              is how every window manager announces the other seven. */
      }
      ${RESIZE_DIRECTIONS.map(
        (dir) =>
          html`<div
            key=${dir}
            className=${`chat-panel__handle chat-panel__handle--${dir}`}
            ...${resizeHandlers(dir)}
            role="separator"
            aria-label=${RESIZE_LABELS[dir]}
          ></div>`,
      )}
    </section>
  `;
};
