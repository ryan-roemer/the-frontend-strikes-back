/* global getComputedStyle:false */
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
 *
 * Only ONE of those newlines is free. A textarea's native default for Enter is
 * "insert a line break", and Shift+Enter rides along on it -- so not calling
 * `preventDefault()` is enough there. Ctrl+Enter and Cmd+Enter have NO default
 * editing action in a textarea: letting them through produces nothing at all, so
 * the break has to be inserted by hand. Measured in Chrome 151; the first cut of
 * this file did just suppress submit and silently ate the keystroke.
 *
 * `isComposing` is checked because Enter commits an IME candidate; submitting
 * there would eat the first word of any non-Latin input.
 *
 * The textarea is UNCONTROLLED and submitted through `form.requestSubmit()`, so
 * the form's own submit path runs and every keystroke does not re-render the
 * transcript above it.
 */
export const Composer = ({ onSend, onStop, busy, disabled, placeholder }) => {
  const textareaRef = useRef(null);

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
      autoGrow();
      onSend(text);
    },
    [autoGrow, busy, disabled, onSend],
  );

  const onKeyDown = useCallback(
    (event) => {
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
    [autoGrow],
  );

  // The button lives INSIDE the bordered box with the textarea, the way joyce and
  // every other chat UI does it: `.chat-composer__box` owns the border, radius and
  // background, and the textarea is stripped bare inside it. Two adjacent bordered
  // controls read as a form; one box with a button in it reads as a composer.
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
