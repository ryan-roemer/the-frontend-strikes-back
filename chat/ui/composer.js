import { createElement, useCallback, useRef } from "react";
import htm from "htm";

const html = htm.bind(createElement);

const MAX_ROWS = 6;

/**
 * The input.
 *
 * Keyboard, per the brief and matching what every chat UI does:
 *
 *   Enter              submit
 *   Ctrl+Enter         newline  (asked for explicitly)
 *   Shift+Enter        newline  (what everyone's fingers already do)
 *   Meta+Enter         newline  (Cmd, on this deck's home platform)
 *   Up / Down          walk back and forth through past questions
 *
 * See `recall` below for when the arrows navigate rather than move the caret.
 *
 * Only ONE of those newlines is free. A textarea's native default for Enter is
 * "insert a line break", and Shift+Enter rides along on it -- so not calling
 * `preventDefault()` is enough there. Ctrl+Enter and Cmd+Enter have NO default
 * editing action in a textarea: letting them through produces nothing at all, so
 * the break has to be inserted by hand or the keystroke is silently eaten.
 *
 * `isComposing` is checked because Enter commits an IME candidate; submitting
 * there would eat the first word of any non-Latin input.
 *
 * The textarea is UNCONTROLLED and submitted through `form.requestSubmit()`, so
 * the form's own submit path runs and every keystroke does not re-render the
 * transcript above it.
 *
 * @param {string[]} [history] Past questions, oldest first, from `use-conversation.js`.
 * @param {object}   [inputRef] The panel's handle on the textarea, so opening the panel
 *                              can put the caret here. See `ui/panel.js`.
 */
export const Composer = ({
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  history = [],
  inputRef,
}) => {
  const ownRef = useRef(null);
  const textareaRef = inputRef ?? ownRef;

  /**
   * Where in `history` the Up arrow has walked to: -1 means "not walking, this is what
   * was typed". `draft` holds that typed text while walking, so Down all the way back
   * returns it instead of leaving the composer holding an old question.
   *
   * Refs rather than state: nothing here renders, and the textarea is uncontrolled, so a
   * re-render per keypress would buy only the transcript above re-rendering too.
   */
  const cursor = useRef(-1);
  const draft = useRef("");

  // Grow with the content up to a ceiling, then scroll. Reset to `auto` first or
  // the height only ever ratchets upward as text is deleted.
  const autoGrow = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 20;
    const max = lineHeight * MAX_ROWS;
    node.style.height = `${Math.min(node.scrollHeight, max)}px`;
    node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
  }, []);

  const submit = useCallback(
    (event) => {
      event.preventDefault();
      const node = textareaRef.current;
      const text = node?.value.trim();
      if (!text || busy || disabled) return;
      node.value = "";
      cursor.current = -1;
      draft.current = "";
      autoGrow();
      onSend(text);
    },
    [autoGrow, busy, disabled, onSend],
  );

  /** Replace the whole value and leave the caret at the end, ready to edit. */
  const replace = useCallback(
    (node, text) => {
      node.value = text;
      autoGrow();
      node.setSelectionRange(text.length, text.length);
    },
    [autoGrow],
  );

  /**
   * Up and Down through past questions.
   *
   * WHEN THIS WINS OVER THE CARET: only when the caret has nowhere to go. Up navigates
   * while the caret sits on the FIRST line of the textarea, Down while it sits on the
   * LAST -- which for the one-line composer that is nearly always in front of somebody is
   * every press, and for a recalled multi-line question is only the presses that would
   * otherwise do nothing. That is readline's rule, and it is the one every terminal has
   * already taught these fingers.
   *
   * Any modifier bails out: Shift+Up selects, and Alt/Cmd+Up jump by word or to the top.
   * Walking off the old end of the list STAYS on the oldest entry rather than wrapping --
   * wrapping makes it impossible to tell where you are in a list you cannot see.
   *
   * @returns {boolean} Whether the key was consumed.
   */
  const recall = useCallback(
    (event) => {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return false;
      }

      const node = event.currentTarget;
      const { value, selectionStart, selectionEnd } = node;
      const back = event.key === "ArrowUp";

      // `lastIndexOf(…, start - 1)` is -1 for a caret at 0, which is the answer we want
      // there anyway: an empty composer is on its first line and its last.
      const onEdge = back
        ? value.lastIndexOf("\n", selectionStart - 1) === -1
        : value.indexOf("\n", selectionEnd) === -1;
      if (!onEdge) return false;

      if (back) {
        if (history.length === 0) return false;
        // First step off the draft: keep it, so Down can hand it back.
        if (cursor.current === -1) {
          draft.current = value;
          cursor.current = history.length - 1;
        } else {
          cursor.current = Math.max(0, cursor.current - 1);
        }
        replace(node, history[cursor.current]);
        return true;
      }

      // Down only means anything once Up has been pressed.
      if (cursor.current === -1) return false;

      if (cursor.current >= history.length - 1) {
        cursor.current = -1;
        replace(node, draft.current);
        return true;
      }
      cursor.current += 1;
      replace(node, history[cursor.current]);
      return true;
    },
    [history, replace],
  );

  const onKeyDown = useCallback(
    (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (recall(event)) event.preventDefault();
        return;
      }

      if (event.key !== "Enter") return;
      if (event.nativeEvent.isComposing) return;

      // Shift+Enter: the textarea's own default already breaks the line, and
      // leaving it to the browser keeps the native undo stack intact.
      if (event.shiftKey) return;

      // Ctrl/Cmd+Enter: no default action exists, so insert the break. Via
      // `setRangeText` rather than string surgery on `value`, so a break lands at
      // the caret (and replaces a selection) instead of at the end.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const node = event.currentTarget;
        node.setRangeText("\n", node.selectionStart, node.selectionEnd, "end");
        autoGrow();
        return;
      }

      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    },
    [autoGrow, recall],
  );

  // The button lives INSIDE the bordered box with the textarea: `.chat-composer__box`
  // owns the border, radius and background, and the textarea is stripped bare inside it.
  // Two adjacent bordered controls read as a form; one box with a button in it reads as
  // a composer.
  return html`
    <form className="chat-composer" onSubmit=${submit}>
      <div className="chat-composer__box">
        <textarea
          ref=${textareaRef}
          className="chat-composer__input"
          rows="1"
          placeholder=${placeholder}
          disabled=${disabled}
          onInput=${autoGrow}
          onKeyDown=${onKeyDown}
          aria-label="Message the deck assistant"
        ></textarea>
        ${busy
          ? html`<button
              type="button"
              className="chat-composer__button chat-composer__button--stop"
              onClick=${onStop}
              title="Stop generating"
              aria-label="Stop generating"
            >
              <i className="ph-fill ph-stop-circle" aria-hidden="true"></i>
            </button>`
          : html`<button
              type="submit"
              className="chat-composer__button"
              disabled=${disabled}
              title="Send"
              aria-label="Send"
            >
              <i
                className="ph-fill ph-paper-plane-right"
                aria-hidden="true"
              ></i>
            </button>`}
      </div>
    </form>
  `;
};
