import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import htm from "htm";
import {
  cancelDownload,
  contextInfo,
  deleteDownload,
  load,
  modelInfo,
  refresh,
  stateMeta,
  unload,
} from "../agent/model-state.js";
import { STATES } from "../agent/states.js";
import { useModelState } from "./use-model-state.js";

const html = htm.bind(createElement);

/** Elapsed load time, next to the label. */
const formatElapsed = (ms) =>
  ms == null ? null : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const InfoModal = ({ onClose }) => {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  // One liveness flag for BOTH the mount read and the post-delete re-read. The delete path
  // is the one that needs it: the modal is a click away from being dismissed, and
  // `modelInfo()` waits on a storage estimate.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    modelInfo()
      .then((value) => live.current && setInfo(value))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Delete the downloaded model.
   *
   * Only rendered when the ACTIVE provider owns its bytes. Under the Chrome Prompt API the
   * model belongs to the browser, so there is nothing here to delete and the honest thing
   * to show is `manageNote` -- copyable text pointing at `chrome://on-device-internals`.
   *
   * On LiteRT it is the affordance that matters most when something has gone wrong: a
   * failed load with no way to clear the cache is otherwise unrecoverable without devtools.
   */
  const onDelete = useCallback(async () => {
    setBusy(true);
    try {
      await deleteDownload();
      reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const rows = info?.rows ?? [];

  return html`
    <div className="chat-modal" role="dialog" aria-label="Model info">
      <div className="chat-modal__head">
        <span>On-device model</span>
        <button
          type="button"
          className="chat-icon-button"
          onClick=${onClose}
          aria-label="Close"
        >
          <i className="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <dl className="chat-modal__rows">
        ${rows.map(
          ([label, value]) =>
            html`<div key=${label}>
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>`,
        )}
      </dl>
      ${
        "" /* A real button on a provider that owns its bytes; a pointer at the browser's
              own page on one that does not. The difference IS the story -- see the table
              in `providers/index.js`. */
      }
      <p className="chat-modal__note">
        ${info?.manageNote
          ? html`${info.manageNote.text} <code>${info.manageNote.url}</code>.`
          : info?.canDelete
            ? html`This deck downloaded the model, so it can delete it too.
                <button
                  type="button"
                  className="chat-text-button"
                  onClick=${onDelete}
                  disabled=${busy}
                >
                  ${busy ? "deleting…" : `delete ${info.size ?? "it"}`}
                </button>`
            : html`The model is fetched on first use and cached in this browser.
              Nothing is sent anywhere.`}
      </p>
    </div>
  `;
};

/**
 * The model's state as icons.
 *
 * A FRAGMENT, NOT A ROW: these render straight into the header's action group, so nothing
 * here may assume it owns a container. Spacing and alignment belong to the group.
 *
 * Four slots, always in the same order and always the same width:
 *
 *   1. PERCENT -- download progress, and the only thing here that comes and goes.
 *   2. STATUS  -- the state icon. Clicking it means whatever the current state says
 *                 it means (download / load / unload / cancel / retry), which is the
 *                 pattern's whole trick: one control, no modes to explain.
 *   3. TRASH   -- free the conversation, which drops the transcript with it. Distinct
 *                 from the header's broom, which recreates a conversation so you can
 *                 keep talking; this one tears down to nothing. It only calls
 *                 `unload()` -- see the note on `discard`.
 *   4. INFO    -- what is knowable about the model.
 *
 * Only the ones that apply are rendered, with NO reserved slot. Holding a hidden
 * placeholder open to stop the row shifting reads as a broken icon inline in a
 * right-aligned group -- a 26px hole between the state and info icons. Nothing that
 * matters moves anyway: the group is anchored on its RIGHT edge, so close, recentre and
 * the broom hold their positions and only the state icon slides.
 */
export const ModelControls = () => {
  const state = useModelState();
  const [showInfo, setShowInfo] = useState(false);
  const meta = stateMeta(state.status);

  const percent =
    state.progress != null ? Math.round(state.progress * 100) : null;

  // One control, no modes to explain: the click means whatever the current state says it
  // means. `recheck` exists only for Chrome, whose download is not ours to cancel -- looking
  // again is the one genuinely useful thing available there, because Chrome reports no
  // completion event for a download it started itself.
  //
  // Every one of these is async and none is awaited, so each needs its own catch: a click
  // handler that lets a promise reject produces an unhandled rejection in the console of a
  // deck being presented, and all four already report failure through the state machine.
  const onPrimary = useCallback(() => {
    const swallow = () => {};
    if (meta.action === "load") load().catch(swallow);
    else if (meta.action === "unload") unload();
    else if (meta.action === "cancel") cancelDownload().catch(swallow);
    else if (meta.action === "recheck") refresh().catch(swallow);
  }, [meta.action]);

  // Just `unload()`. It bumps the model-state epoch, and the panel wipes the transcript
  // from that -- so the trash does not need to know the transcript exists, and every other
  // path that drops the model's memory gets the same behaviour for free.
  const discard = useCallback(() => {
    unload();
  }, []);

  const canDiscard = state.status === STATES.READY;

  const statusLabel = [
    meta.title,
    // Byte counts, not just a percentage. At 2 GB a percentage cannot distinguish a
    // slow download from a stalled one, which is the only question worth answering
    // while watching this on stage.
    state.progressText ? `— ${state.progressText}` : null,
    formatElapsed(state.elapsed) ? `(${formatElapsed(state.elapsed)})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return html`
    <${Fragment}>
      ${
        "" /* Percent leads the group, so the one transient readout appears at the
              boundary between the panel's controls and the model's. It only exists
              while downloading, and the icons after it do not move when it goes --
              they are already right-aligned as a block. */
      }
      ${percent != null
        ? html`<span
            className="chat-model__progress"
            title=${state.progressText ?? ""}
            >${percent}%</span
          >`
        : null}
      ${meta.action
        ? html`<button
            type="button"
            className=${`chat-icon-button chat-model__state chat-model__state--${meta.tone}`}
            onClick=${onPrimary}
            title=${statusLabel}
            aria-label=${statusLabel}
          >
            <i className=${`ph-fill ${meta.icon}`} aria-hidden="true"></i>
          </button>`
        : html`<span
            className=${`chat-icon-button chat-model__state chat-model__state--${meta.tone}`}
            title=${statusLabel}
            aria-label=${statusLabel}
            role="img"
          >
            <i className=${`ph-fill ${meta.icon}`} aria-hidden="true"></i>
          </span>`}
      ${canDiscard
        ? html`<button
            type="button"
            className="chat-icon-button chat-model__trash"
            onClick=${discard}
            title="Discard session and conversation"
            aria-label="Discard session and conversation"
          >
            <i className="ph ph-trash" aria-hidden="true"></i>
          </button>`
        : null}
      <button
        type="button"
        className="chat-icon-button chat-model__info"
        onClick=${() => setShowInfo((open) => !open)}
        title="Model info"
        aria-label="Model info"
        aria-expanded=${showInfo}
      >
        <i className="ph ph-info" aria-hidden="true"></i>
      </button>
      ${showInfo
        ? html`<${InfoModal} onClose=${() => setShowInfo(false)} />`
        : null}
    <//>
  `;
};

/**
 * Context usage, as an underline along the whole bar.
 *
 * Separate from the controls because it is not a control and does not belong in their
 * flow: it spans the bar rather than occupying a slot in it, so it is positioned
 * against the bar itself. Amber at 75, red at 90 -- the point where the broom stops
 * being optional.
 *
 * Renders nothing without a session, so the bar simply has no underline until there
 * is a context to report. That is honest rather than an empty gauge.
 */
export const ContextUnderline = () => {
  const { revision } = useModelState();

  // READ IN AN EFFECT, not in the body. `contextInfo()` reaches past the published state
  // into the live chat handle, so calling it during render mixes a value from the store
  // with one from outside it and the two can disagree. `touch()` bumps `revision` twice per
  // turn -- once synchronously, once after the resample -- so keying on it picks up both.
  const [context, setContext] = useState(null);
  useEffect(() => {
    setContext(contextInfo());
  }, [revision]);

  if (!context) return null;

  return html`<span
    className=${`chat-model__meter${
      context.pct >= 90
        ? " chat-model__meter--critical"
        : context.pct >= 75
          ? " chat-model__meter--warn"
          : ""
    }`}
    title=${`Context: ${context.used.toLocaleString()} of ${context.total.toLocaleString()} tokens (${context.pct}%)`}
  >
    <span
      className="chat-model__meter-fill"
      style=${{ width: `${Math.min(100, context.pct)}%` }}
    ></span>
  </span>`;
};
