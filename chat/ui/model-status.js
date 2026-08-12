import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useState,
} from "react";
import htm from "htm";
import {
  STATES,
  STATE_META,
  cancelDownload,
  contextInfo,
  deleteDownload,
  getState,
  load,
  modelInfo,
  subscribe,
  unload,
} from "../agent/model-state.js";

const html = htm.bind(createElement);

/** joyce shows elapsed next to the label; same idea, same terse format. */
const formatElapsed = (ms) =>
  ms == null ? null : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const useModelState = () => {
  const [state, setState] = useState(getState);
  useEffect(() => subscribe(setState), []);
  return state;
};

const InfoModal = ({ onClose }) => {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    modelInfo().then(setInfo);
  }, []);

  useEffect(() => {
    let live = true;
    modelInfo().then((value) => live && setInfo(value));
    return () => {
      live = false;
    };
  }, []);

  /**
   * Delete the downloaded model.
   *
   * This button could not exist under the Prompt API -- the model belonged to the
   * browser, so the honest thing to show was copyable text pointing at
   * `chrome://on-device-internals`. We own the bytes now, so the affordance is
   * real, and it is the one that matters most when something has gone wrong: a
   * failed load with no way to clear the cache is otherwise unrecoverable without
   * devtools.
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

  const adapter = info?.gpu?.adapter;
  const rows = info
    ? [
        ["Status", STATE_META[info.status]?.title ?? info.status],
        ["Model", `${info.model.label} · ${info.model.quantization}`],
        ["File", `${info.model.file} (${info.size})`],
        ["Backend", `${info.backend} · WebGPU`],
        [
          "GPU",
          adapter
            ? [adapter.vendor, adapter.architecture]
                .filter(Boolean)
                .join(" ") || "available"
            : (info.gpu?.reason ?? "—"),
        ],
        ["shader-f16", adapter ? (adapter.shaderF16 ? "yes" : "no") : "—"],
        [
          "Downloaded",
          info.cached
            ? "yes, verified complete"
            : info.cacheAvailable
              ? "no"
              : "no (this browser has no Cache API)",
        ],
        ["Engine", info.engineResident ? "loaded on the GPU" : "not loaded"],
        [
          "Context",
          info.context
            ? `${info.context.used.toLocaleString()} / ${info.context.total.toLocaleString()} (${info.context.pct}%)`
            : "no session",
        ],
        ["Loaded in", formatElapsed(info.elapsed) ?? "—"],
        // Real numbers from the runtime, and a far better row than the Prompt API's
        // `params()` -- which was absent in Chrome 151 anyway. Omitted rather than
        // shown as zeroes on a conversation that has not generated yet: "0 in, 0 out
        // · 0 tok/s" reads as a broken readout rather than an idle one.
        ...(info.benchmark?.lastDecodeTokenCount
          ? [
              [
                "Last turn",
                `${info.benchmark.lastPrefillTokenCount ?? "?"} in, ` +
                  `${info.benchmark.lastDecodeTokenCount} out · ` +
                  `${Math.round(info.benchmark.lastDecodeTokensPerSecond ?? 0)} tok/s`,
              ],
            ]
          : []),
        ...(info.storage?.quota
          ? [
              [
                "Storage",
                `${(info.storage.free / 1e9).toFixed(1)} GB free of ` +
                  `${(info.storage.quota / 1e9).toFixed(1)} GB`,
              ],
            ]
          : []),
        ...(info.error ? [["Last error", info.error]] : []),
      ]
    : [];

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
        "" /* The page owns the bytes, so this is a real button rather than the
              apology and copyable chrome:// URL that used to live here. */
      }
      <p className="chat-modal__note">
        ${info?.cached
          ? html`This deck downloaded the model, so it can delete it too.
              <button
                type="button"
                className="chat-text-button"
                onClick=${onDelete}
                disabled=${busy}
              >
                ${busy ? "deleting…" : `delete ${info.size}`}
              </button>`
          : html`The model is fetched from HuggingFace on first use and cached
            in this browser. Nothing is sent anywhere.`}
      </p>
    </div>
  `;
};

/**
 * The model's state as icons, after joyce's `LoadingButton`.
 *
 * A FRAGMENT, not a row. These used to live in a second bar under the panel header,
 * which cost a whole strip of vertical space to say something that is three icons
 * wide -- so they are now rendered straight into the header's action group, and the
 * bar they used to occupy is gone. Nothing here may assume it owns a container:
 * spacing and alignment belong to the group it is dropped into.
 *
 * Four slots, always in the same order and always the same width:
 *
 *   1. PERCENT -- download progress, and the only thing here that comes and goes.
 *   2. STATUS  -- the state icon. Clicking it means whatever the current state says
 *                 it means (download / load / unload / cancel / retry), which is the
 *                 pattern's whole trick: one control, no modes to explain.
 *   3. TRASH   -- discard the session AND the transcript. Distinct from the header's
 *                 broom, which recreates a conversation so you can keep talking;
 *                 this one tears down to nothing.
 *   4. INFO    -- what is knowable about the model.
 *
 * The trash slot is RESERVED even when there is nothing to discard -- a hidden
 * placeholder holds the width, exactly as joyce does it, so the group doesn't shuffle
 * sideways every time the state changes. That matters more now than it did in a bar
 * of its own: these icons sit next to the close button, and a row that shifts under
 * the cursor is a row you misclick.
 */
export const ModelControls = ({ onDiscardConversation }) => {
  const state = useModelState();
  const [showInfo, setShowInfo] = useState(false);
  const meta = STATE_META[state.status] ?? STATE_META[STATES.UNSUPPORTED];

  const percent =
    state.progress != null ? Math.round(state.progress * 100) : null;

  const onPrimary = useCallback(() => {
    if (meta.action === "load") load();
    else if (meta.action === "unload") unload();
    else if (meta.action === "cancel") cancelDownload();
  }, [meta.action]);

  const discard = useCallback(() => {
    unload();
    onDiscardConversation?.();
  }, [onDiscardConversation]);

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
      ${
        "" /* Rendered only when there is something to discard, with NO reserved slot.
              joyce holds the box open so a row of icons never shifts, and that was
              right while these lived in a bar of their own -- but inline in a
              right-aligned group it reads as a broken icon: a 26px hole between the
              state and info icons, which is exactly what it looks like. The shift it
              was preventing costs nothing here, because the group is anchored on its
              RIGHT edge: close, recentre and the broom hold their positions whatever
              happens, and only the state icon slides. */
      }
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
        className="chat-icon-button"
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
  // Subscribed for the side effect: `contextInfo()` is a plain read, and the revision
  // bump on `touch()` is what makes it re-run after a turn.
  useModelState();
  const context = contextInfo();
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
