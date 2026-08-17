import { createElement, useCallback, useEffect, useRef } from "react";
import htm from "htm";
import { setEnabled } from "../state.js";
import { useConversation } from "../use-conversation.js";
import { useDeck } from "../use-deck.js";
import { refresh, restart } from "../agent/model-state.js";
import { STATES } from "../agent/states.js";
import { streamAnswer } from "../agent/session.js";
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
 * The first thing anyone sees, and the only place the assistant gets to say what
 * it is good at.
 *
 * IT NAMES THE DECK NOW, because it can -- `agent/deck-context.js` gives it the
 * outline and the slide a question is asked from. A panel that opened saying "ask
 * it anything" was honest when the model knew nothing; now it undersells, and the
 * failure mode is a room full of people asking a 2B model general-knowledge
 * questions it answers badly instead of deck questions it answers well.
 *
 * THE SUGGESTIONS SEND ON CLICK rather than filling the composer. One tap is the
 * whole point from a stage -- and each one is chosen to exercise a different
 * source, so the three of them are a live demo of the context design in order:
 * the outline, the current slide, then the argument in the system prompt.
 *
 * The middle one NAMES THE SLIDE, from the bus, so it re-reads on every
 * navigation. That is the cheapest possible proof the thing is actually watching
 * the deck, offered before anyone has typed a word. It degrades to "this slide"
 * when the bridge is down -- overview and presenter mode both unmount it, and a
 * confident wrong slide number in the greeting would be a bad first impression.
 */
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
  // `streamAnswer` already IS the `respond({ text, onChunk, signal })` contract, so
  // there is no responder module between them any more -- the router that used to
  // sit here is gone.
  const { entries, streaming, busy, error, send, stop, clear } =
    useConversation(streamAnswer);

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
          "" /* Left-aligned, next to the sparkle and away from the action group. It is the
                one control here that changes WHAT is answering rather than what happens to
                it, and it earned the space the undo and revert buttons used to take. */
        }
        <${ProviderSwitch} />
        <span className="chat-panel__actions">
          ${
            "" /* The model's own controls, inline. Percent, state, trash, info --
                  see `ModelControls`. They lead the group so the panel's controls
                  (broom, recentre, close) stay in the same order and the same place
                  they have always been, hard right. */
          }
          <${ModelControls} />
          <button
            type="button"
            className="chat-icon-button"
            onClick=${newChat}
            title="New chat (fresh context)"
            aria-label="New chat"
          >
            <i className="ph ph-broom" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${reset}
            title="Reset panel position and size"
            aria-label="Reset panel position and size"
          >
            <i className="ph ph-crosshair" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${() => setEnabled(false)}
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
        placeholder=${dead
          ? "No on-device model available"
          : "Ask or instruct… (Enter to send)"}
      />

      ${"" /* Resize grip. Its own pointer handlers, same gesture machinery. */}
      <div
        className="chat-panel__grip"
        ...${resizeHandlers}
        role="separator"
        aria-label="Resize"
      ></div>
    </section>
  `;
};
