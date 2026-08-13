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
import { respond } from "../agent/plan.js";
import { usePanelGeometry } from "./geometry.js";
import { Transcript } from "./transcript.js";
import { Composer } from "./composer.js";
import { ContextUnderline, ModelControls } from "./model-status.js";
import { Unavailable } from "./unavailable.js";
import {
  reset as resetEdits,
  subscribe as subscribeEdits,
  summary as editSummary,
  undo as undoEdit,
} from "../edit/patches.js";

const html = htm.bind(createElement);

const EmptyState = () => html`
  <div className="chat-empty">
    <p>Ask about this deck, or tell me what to change.</p>
    <ul>
      <li>“Give me the short version of this talk.”</li>
      <li>“Make this heading bigger.”</li>
      <li>“Go to the WebMCP chapter.”</li>
    </ul>
  </div>
`;

const useModelState = () => {
  const [state, setState] = useState(getState);
  useEffect(() => subscribe(setState), []);
  return state;
};

/** How many deck edits are outstanding, for the undo and revert controls. */
const useEdits = () => {
  const [state, setState] = useState(editSummary);
  useEffect(() => subscribeEdits(setState), []);
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
  const edits = useEdits();
  const panelRef = useRef(null);
  const { reset, dragHandlers, resizeHandlers } = usePanelGeometry(panelRef);
  const { entries, streaming, busy, error, send, stop, clear } =
    useConversation(respond);

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
        <span className="chat-panel__actions">
          ${
            "" /* The model's own controls, inline. Percent, state, trash, info --
                  see `ModelControls`. They lead the group so the panel's controls
                  (undo, revert, broom, recentre, close) stay in the same order and
                  the same place they have always been, hard right. */
          }
          <${ModelControls} />
          ${edits.canUndo
            ? html`<button
                type="button"
                className="chat-icon-button chat-icon-button--accent"
                onClick=${undoEdit}
                title=${`Undo: ${edits.labels.at(-1)}`}
                aria-label="Undo last deck edit"
              >
                <i className="ph ph-arrow-u-up-left" aria-hidden="true"></i>
              </button>`
            : null}
          ${edits.count
            ? html`<button
                type="button"
                className="chat-icon-button"
                onClick=${resetEdits}
                title=${`Revert all ${edits.count} deck edit${edits.count === 1 ? "" : "s"}`}
                aria-label="Revert all deck edits"
              >
                <i
                  className="ph ph-arrow-counter-clockwise"
                  aria-hidden="true"
                ></i>
              </button>`
            : null}
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
