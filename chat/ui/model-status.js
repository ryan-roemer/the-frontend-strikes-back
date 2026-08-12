/* global navigator:false */
import { createElement, useCallback, useEffect, useState } from "react";
import htm from "htm";
import {
  STATES,
  STATE_META,
  contextInfo,
  getState,
  load,
  modelInfo,
  refresh,
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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    modelInfo().then((value) => live && setInfo(value));
    return () => {
      live = false;
    };
  }, []);

  const copyInternals = useCallback(() => {
    navigator.clipboard
      ?.writeText("chrome://on-device-internals")
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, []);

  const rows = info
    ? [
        ["Status", STATE_META[info.status]?.title ?? info.status],
        ["availability()", info.availability ?? "—"],
        [
          "Context",
          info.context
            ? `${info.context.used.toLocaleString()} / ${info.context.total.toLocaleString()} (${info.context.pct}%)`
            : "no session",
        ],
        ["Session created in", formatElapsed(info.elapsed) ?? "—"],
        // `LanguageModel.params()` is absent in Chrome 151 (verified: not a
        // function). Two rows of "—" read as a bug in this panel rather than a
        // gap in the platform, so say which it is and take the space back.
        ...(info.params
          ? [
              [
                "topK",
                `${info.params.defaultTopK} (max ${info.params.maxTopK})`,
              ],
              [
                "temperature",
                `${info.params.defaultTemperature} (max ${info.params.maxTemperature})`,
              ],
            ]
          : [["params()", "not exposed by this browser"]]),
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
        "" /* Honest about the one thing the trash cannot do. A page can neither
              delete the model nor navigate to a chrome:// URL, so this is
              copyable text rather than a link that would silently do nothing. */
      }
      <p className="chat-modal__note">
        The model belongs to the browser, so a page can't delete it from disk.
        Manage it at
        <code>chrome://on-device-internals</code>
        <button
          type="button"
          className="chat-text-button"
          onClick=${copyInternals}
        >
          ${copied ? "copied" : "copy"}
        </button>
      </p>
    </div>
  `;
};

/**
 * The model's state as icons, after joyce's `LoadingButton`.
 *
 * Three slots, always in the same order and always the same width:
 *
 *   1. STATUS  -- the state icon. Clicking it means whatever the current state
 *                 says it means (download / load / unload / retry), which is the
 *                 pattern's whole trick: one control, no modes to explain.
 *   2. TRASH   -- discard the session AND the transcript. Distinct from the
 *                 header's broom, which recreates a session so you can keep
 *                 talking; this one tears down to nothing.
 *   3. INFO    -- what is knowable about the model.
 *
 * The trash slot is RESERVED even when there is nothing to discard -- a hidden
 * placeholder holds the width, exactly as joyce does it, so the row doesn't
 * shuffle sideways every time the state changes.
 */
export const ModelStatus = ({ onDiscardConversation }) => {
  const state = useModelState();
  const [showInfo, setShowInfo] = useState(false);
  const meta = STATE_META[state.status] ?? STATE_META[STATES.UNSUPPORTED];

  const context = contextInfo();
  const percent =
    state.progress != null ? Math.round(state.progress * 100) : null;

  const onPrimary = useCallback(() => {
    if (meta.action === "load") load();
    else if (meta.action === "unload") unload();
    else if (meta.action === "recheck") refresh();
  }, [meta.action]);

  const discard = useCallback(() => {
    unload();
    onDiscardConversation?.();
  }, [onDiscardConversation]);

  const canDiscard = state.status === STATES.READY;

  const statusLabel = [
    meta.title,
    percent != null ? `(${percent}%)` : null,
    formatElapsed(state.elapsed) ? `(${formatElapsed(state.elapsed)})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return html`
    <div className="chat-model">
      <div className="chat-model__icons">
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
          : html`<span
              className="chat-icon-button chat-model__trash chat-model__trash--placeholder"
              aria-hidden="true"
            >
              <i className="ph ph-trash"></i>
            </span>`}
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
      </div>

      ${percent != null
        ? html`<span className="chat-model__progress">${percent}%</span>`
        : null}
      ${
        "" /* Context meter. Amber at 75, red at 90 -- the point where the broom
              in the header stops being optional. */
      }
      ${context
        ? html`<span
            className=${`chat-model__meter${
              context.pct >= 90
                ? " chat-model__meter--critical"
                : context.pct >= 75
                  ? " chat-model__meter--warn"
                  : ""
            }`}
            title=${`Context: ${context.used.toLocaleString()} of ${context.total.toLocaleString()} tokens`}
          >
            <span
              className="chat-model__meter-fill"
              style=${{ width: `${Math.min(100, context.pct)}%` }}
            ></span>
          </span>`
        : null}
      ${showInfo
        ? html`<${InfoModal} onClose=${() => setShowInfo(false)} />`
        : null}
    </div>
  `;
};
