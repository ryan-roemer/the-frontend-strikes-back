import { createElement, useCallback, useEffect, useRef, useState } from "react";
import htm from "htm";
import { setEnabled } from "../state.js";
import { useConversation } from "../use-conversation.js";
import {
  STATES,
  getState,
  refresh,
  restart,
  subscribe,
} from "../agent/model-state.js";
import { streamAnswer } from "../agent/session.js";
import { usePanelGeometry } from "./geometry.js";
import { Transcript } from "./transcript.js";
import { Composer } from "./composer.js";
import { ContextUnderline, ModelControls } from "./model-status.js";
import { ProviderSwitch } from "./provider-switch.js";
import { Unavailable } from "./unavailable.js";

const html = htm.bind(createElement);

/**
 * Deliberately says nothing about the deck.
 *
 * The chat knows the model runs on this machine and nothing else. Deck knowledge
 * comes back later, on purpose, once the two providers are solid.
 */
const EmptyState = () => html`
  <div className="chat-empty">
    <p>A model running entirely on this machine. Ask it anything.</p>
    <ul>
      <li>“Explain WebGPU in two sentences.”</li>
      <li>“Write a haiku about shipping on a Friday.”</li>
    </ul>
  </div>
`;

const useModelState = () => {
  const [state, setState] = useState(getState);
  useEffect(() => subscribe(setState), []);
  return state;
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

  /**
   * Keep deck navigation out of the panel.
   *
   * Spectacle binds left/right on `document` through mousetrap, whose
   * `stopCallback` already spares events targeted at a TEXTAREA -- so typing is
   * safe for free. A focused BUTTON in this panel is not: arrow keys there would
   * both do nothing visible and silently change slides. Escape closes, which is
   * why it is handled here rather than globally.
   */
  const onKeyDown = useCallback((event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setEnabled(false);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.stopPropagation();
    }
  }, []);

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
  // Keyed on the epoch ALONE, deliberately. `clear` is a fresh closure on most renders, so
  // including it would wipe the transcript on any identity change rather than only when the
  // model actually forgets.
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
          <i className="ph-fill ph-robot" aria-hidden="true"></i>
        </span>
        ${
          "" /* Left-aligned, next to the robot and away from the action group. It is the
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
            empty=${html`<${EmptyState} />`}
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
