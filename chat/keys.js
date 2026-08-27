/**
 * The deck-wide keyboard chords: open the assistant, open the tool inspector, close
 * whatever is on top.
 *
 * ON `event.code`, NOT `event.key`. This deck's home platform is macOS, where Option is
 * a compose key: Shift+Option+C arrives as `key === "Ç"` and Shift+Option+T as `"ˇ"`
 * (a dead key, which on some layouts reports an empty string until the next keystroke).
 * `code` is the physical key regardless of layout or modifier, so `KeyC` is `KeyC` on a
 * Dvorak keyboard in Reykjavik.
 *
 * WHY SHIFT+ALT AND NOT SOMETHING SHORTER. Every bare letter belongs to Spectacle --
 * `p` presenter, `o` overview, `f` fullscreen -- and every Cmd/Ctrl chord belongs to the
 * browser. Shift+Alt+letter is one of the few spaces left that neither claims, and it
 * still works while the caret is in the composer (we `preventDefault`, so no stray `Ç`).
 *
 * ESCAPE IS A FALLBACK, not the primary path. The tool inspector and the context sheet
 * focus themselves on mount and `stopPropagation` on Escape, and the chat panel does the
 * same for keys that land inside it -- React attaches its listeners at `#chat-root`, so a
 * handled Escape never reaches this listener on `window` at all. What does reach here is
 * an Escape pressed while focus is out on the deck, which is exactly where focus goes the
 * moment somebody clicks a slide behind the open panel. Before this, that Escape did
 * nothing and the panel looked stuck.
 *
 * Installed and torn down by `mountChat()`, like everything else that touches globals.
 */
import { isEnabled, setEnabled, toggleEnabled } from "./state.js";
import { isOpen, setOpen, toggleOpen } from "./tools/state.js";
import { getShown } from "./context/state.js";

const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");

/** What to show in a tooltip, in the notation that platform's users read. */
const hint = (letter) => (MAC ? `⇧⌥${letter}` : `Shift+Alt+${letter}`);

export const CHAT_KEY_HINT = hint("C");
export const TOOLS_KEY_HINT = hint("T");

/** Shift+Alt held, and nothing else. Cmd/Ctrl variants belong to the browser. */
const chord = (event) =>
  event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey;

const onKeyDown = (event) => {
  // Auto-repeat from a held chord would flap the panel open and shut.
  if (event.repeat) return;

  if (chord(event)) {
    if (event.code === "KeyC") {
      event.preventDefault();
      toggleEnabled();
      return;
    }
    if (event.code === "KeyT") {
      event.preventDefault();
      toggleOpen();
    }
    return;
  }

  if (event.key !== "Escape") return;

  // Topmost first. The context sheet is always focused while it is up, so an Escape
  // that got this far is not for it -- but closing the panel out from under it would
  // still be wrong, so it wins by being checked first and doing nothing.
  if (getShown()) return;
  if (isOpen()) {
    setOpen(false);
    return;
  }
  if (isEnabled()) setEnabled(false);
};

/**
 * Bind the chords. Returns the unbind.
 *
 * BUBBLE PHASE, deliberately: that is what lets a surface with its own Escape handler
 * swallow the key before it arrives here. A capture-phase listener would fire first and
 * close the panel behind whichever sheet the user was actually dismissing.
 */
export const installKeys = () => {
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
};
