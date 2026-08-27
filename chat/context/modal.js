import { createElement, useCallback, useEffect, useRef } from "react";
import htm from "htm";
import { hideContext } from "./state.js";
import { useCopy } from "../ui/use-copy.js";
import { useDismissKeys } from "../ui/use-dismiss-keys.js";

const html = htm.bind(createElement);

/**
 * Everything that went into one answer, and the answer.
 *
 * THE REPLY IS HERE TOO, below a rule, because the question this sheet gets opened to
 * settle is almost always "why did it say THAT" -- and the prompt alone cannot answer it.
 * Attached by `ui/transcript.js`, which is the first place both halves of a turn exist at
 * once; `onPrompt` fires before the first delta, so no provider capture can carry it.
 *
 * NOT THE STRING THE MODEL READ -- neither provider ever builds one in JS. Both hand a
 * message array to a runtime that applies the model's turn template across a wasm or
 * process boundary. What is shown here is the INGREDIENTS, captured at send time.
 *
 * THE INGREDIENTS AS THE PROVIDER HAD THEM, not as the panel shows them. The two disagree
 * on purpose: LiteRT sends at most three previous exchanges, so a long conversation on
 * screen is a short one in the model -- which explains half the surprising answers.
 *
 * THE PINNED REGION is the same idea one level down: `deck-context.js` sends a slide's text
 * once and never again, so the model carries deck content that appears nowhere in the
 * transcript and was never typed by anyone. LiteRT reports it as its own region; Chrome has
 * none, so it shows up inside the message it rode in on -- which is where it is.
 *
 * Lazily loaded; see `gate.js`. Default export because `lazy()` requires one.
 */

/** `replay` included so a fixture run is labelled as one rather than as a bare id --
 *  a sheet that says "replay" is the fastest way to notice you are not testing a model. */
const PROVIDERS = {
  litert: "LiteRT-LM",
  chrome: "Chrome Prompt API",
  replay: "Replay (fixture)",
};

const ROLES = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  deck: "Deck",
};

/**
 * Tolerates a capture from before the pinned region existed, and Chrome, which has no
 * separate region to report.
 *
 * ONLY `pinned` IS OPTIONAL. `system`, `history` and `message` are dereferenced without
 * a guard everywhere below, and deliberately: a capture missing any of those is not an
 * older shape, it is a bug in whichever provider built it, and rendering an empty sheet
 * over it would hide exactly the thing this viewer exists to show.
 */
const pinnedOf = (context) => context.pinned ?? [];

/**
 * The line between what went in and what came out, in a copied transcript.
 *
 * SPELLED OUT RATHER THAN A BARE RULE, because the destination is usually somebody else's
 * chat window, where a row of dashes is just a row of dashes. Naming both sides means the
 * paste explains its own shape with no covering note.
 */
const ANSWER_RULE =
  "————— everything above was sent to the model; below is what it replied —————";

/** Characters, not tokens. A token count would have to come from the runtime, and
 *  asking it now would answer for the context it holds NOW, not the one shown. */
const size = (context) =>
  [
    context.system,
    ...pinnedOf(context).map((m) => m.content),
    ...context.history.map((m) => m.content),
    context.message,
  ]
    .join("")
    .length.toLocaleString();

/**
 * One labelled block: who said it, and what they said.
 *
 * `live` MARKS THE TWO BLOCKS A READER IS ACTUALLY LOOKING FOR -- this turn's question and
 * its answer -- and it is a prop rather than a `:last-child` rule because it stopped being
 * positional. The question used to be the last block in the sheet; appending the answer
 * silently took its accent away, which is the failure mode of styling by position.
 */
const Message = ({ role, content, note, live }) => html`
  <div
    className=${`chat-context__message chat-context__message--${role}${live ? " chat-context__message--live" : ""}`}
  >
    <div className="chat-context__role">
      ${ROLES[role] ?? role}
      ${note && html`<span className="chat-context__note">${note}</span>`}
    </div>
    <pre className="chat-context__body">${content}</pre>
  </div>
`;

const ContextModal = ({ context }) => {
  const sheet = useRef(null);
  const body = useRef(null);

  // Focusable via the lowercase `tabindex` below -- prettier formats these html``
  // templates as HTML and rewrites `tabIndex` back on every format run. See the
  // longer note in `chat/tools/modal.js`.
  useEffect(() => sheet.current?.focus(), []);

  /** Escape closes, and arrows are kept off the deck -- see `use-dismiss-keys.js`. */
  const onKeyDown = useDismissKeys(hideContext);

  /**
   * The whole turn as one pasteable transcript.
   *
   * THE ANSWER IS PART OF IT, below a rule. Everything above the rule went INTO the model
   * and everything below came OUT, and that boundary has to survive a copy-paste into a
   * chat window or an issue -- without it, the answer reads as one more `[Assistant]` block
   * in the history and the one thing being diagnosed is indistinguishable from context.
   *
   * `answer` is attached by `ui/transcript.js`, not by a provider: `onPrompt` fires before
   * the first delta, so no capture can contain it. Optional for the same reason `pinned`
   * is -- a context shown from anywhere else, or captured before this existed, still
   * copies cleanly as just the prompt.
   */
  const asText = useCallback(
    () =>
      [
        `[${ROLES.system}]\n${context.system}`,
        ...pinnedOf(context).map((m) => `[${ROLES.deck}]\n${m.content}`),
        ...context.history.map(
          (m) => `[${ROLES[m.role] ?? m.role}]\n${m.content}`,
        ),
        `[${ROLES.user}]\n${context.message}`,
        ...(context.answer
          ? [
              ANSWER_RULE,
              `[${ROLES.assistant}]${context.stopped ? " (stopped early)" : ""}\n${context.answer}`,
            ]
          : []),
      ].join("\n\n"),
    [context],
  );

  const { copied, copy } = useCopy(asText, body);

  // History arrives as a flat message list; a person counts it in question-and-
  // answer pairs, and so does the provider's own limit.
  const exchanges = Math.floor(context.history.length / 2);

  const dropped =
    context.historyLimit != null &&
    context.history.length >= context.historyLimit;

  const pinned = pinnedOf(context);

  return html`
    <div
      ref=${sheet}
      className="chat-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Context sent to the model"
      tabindex=${-1}
      onKeyDown=${onKeyDown}
      onMouseDown=${(event) => {
        if (event.target === event.currentTarget) hideContext();
      }}
    >
      <div className="chat-sheet__card chat-sheet__card--narrow">
        <header className="chat-sheet__bar">
          <span className="chat-sheet__title">
            <i className="ph-fill ph-brackets-curly" aria-hidden="true"></i>
            Context sent
          </span>
          <span className="chat-sheet__badges">
            <span className="chat-sheet__badge"
              >${PROVIDERS[context.provider] ?? context.provider}</span
            >
            ${
              "" /* Built as one string rather than interpolated around the text:
                    htm collapses the whitespace between an expression and the
                    word after it when they land on different source lines, which
                    reads as "0 priorexchanges". */
            }
            <span
              >${`${exchanges} prior ${exchanges === 1 ? "exchange" : "exchanges"}`}</span
            >
            ${pinned.length
              ? html`<span
                  >${`${pinned.length} pinned ${pinned.length === 1 ? "block" : "blocks"}`}</span
                >`
              : null}
            <span>${size(context)} chars</span>
          </span>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${copy}
            title=${copied ? "Copied" : "Copy the whole turn"}
            aria-label=${copied ? "Copied" : "Copy the whole turn"}
          >
            <i
              className=${`ph ph-${copied ? "check" : "copy"}`}
              aria-hidden="true"
            ></i>
          </button>
          <button
            type="button"
            className="chat-icon-button"
            onClick=${hideContext}
            title="Close"
            aria-label="Close"
          >
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </header>

        <div className="chat-context__body-scroll" ref=${body}>
          <${Message} role="system" content=${context.system} />
          ${
            "" /* Between the preface and the turns, which is where they are in the
                  preface the provider built -- and reading order is the only cue a
                  viewer has for that ordering. */
          }
          ${pinned.map(
            (message, i) =>
              html`<${Message}
                key=${`pinned-${i}`}
                role="deck"
                content=${message.content}
                note=${i === 0 ? "sent once, kept" : null}
              />`,
          )}
          ${context.history.map(
            (message, i) =>
              html`<${Message}
                key=${i}
                role=${message.role}
                content=${message.content}
              />`,
          )}
          <${Message}
            role="user"
            content=${context.message}
            note="this question"
            live
          />
          ${
            "" /* WHAT CAME BACK, below a rule that says so. The sheet is otherwise
                  entirely inputs, and appending an output with no boundary would make
                  the reply look like one more thing that was sent. Absent when the
                  context was opened from somewhere with no answer to show. */
          }
          ${context.answer
            ? html`
                <div className="chat-context__rule" role="separator">
                  <span>replied</span>
                </div>
                <${Message}
                  role="assistant"
                  content=${context.answer}
                  note=${context.stopped ? "stopped early" : "this answer"}
                  live
                />
              `
            : null}
        </div>

        ${
          "" /* Three footnotes, each because a reader who does not know it will
                misread what is above: the wasm boundary; why a panel showing six
                exchanges can be a model shown three; and why deck text nobody typed
                is sitting in the preface. */
        }
        <footer className="chat-context__foot">
          The runtime wraps these in the model's own turn template before
          decoding, so the final string is never a value this page can
          read.${pinned.length
            ? html` Deck blocks are sent the first time you ask from a slide and
              kept for the rest of the conversation, so each slide appears at
              most once.`
            : null}${dropped
            ? html` Older exchanges are dropped: this provider keeps the last
              ${context.historyLimit / 2} and no more.`
            : null}
        </footer>
      </div>
    </div>
  `;
};

export default ContextModal;
