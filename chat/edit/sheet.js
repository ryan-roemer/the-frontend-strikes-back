/**
 * The deck's own stylesheet: the one edit channel React cannot touch.
 *
 * React diffs its own previous props against its next props -- never against the
 * DOM -- so it only rewrites what IT changed. A `<style>` element it did not
 * create is invisible to it, and so is every rule inside. Same for
 * styled-components, which manages its own sheet.
 *
 * That makes CSS the durable channel, and it is why every style, colour and
 * custom-property edit goes through here rather than through inline styles:
 *
 *   - react-spring writes `opacity`, `transform` and `display` DIRECTLY onto each
 *     slide's wrapper at 60fps, bypassing React entirely. An inline style on those
 *     properties is gone within a frame. `!important` in a sheet wins.
 *   - `--chapter-accent` is emitted by `applyChapterStyles()` onto `.ch-N`, so a
 *     `:root` override loses on specificity. A `.ch-N` override in THIS sheet wins
 *     on document order, because this element is appended last.
 *
 * Appended last in `<head>`, and regenerated WHOLESALE from the patch log on every
 * change. No incremental rule surgery: it removes a whole class of bug (stale
 * rules, double-applied edits, undo leaving a rule behind) for the cost of
 * rebuilding a string that is never more than a few dozen lines.
 *
 * `textContent` HERE IS FINE, and is the one place in this directory where it is.
 * The prohibition is about deck DOM whose nodes React's fiber still references;
 * this element React has never seen.
 */

const SHEET_ID = "deck-edit-sheet";

const node = () => {
  const existing = document.getElementById(SHEET_ID);
  if (existing) return existing;

  const el = document.createElement("style");
  el.id = SHEET_ID;
  el.dataset.source = "deck-edit";
  document.head.append(el);
  return el;
};

/** Every declaration `!important`, because the competition writes inline. */
const importantly = (declarations) =>
  declarations
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!important$/i.test(d) ? d : `${d} !important`))
    .join("; ");

/**
 * Rebuild the whole sheet from the CSS patches in the log.
 *
 * In log order, so a later edit to the same property simply wins by appearing
 * later -- no diffing, no de-duplication, no way for undo to leave a rule behind.
 */
export const render = (patches) => {
  const css = patches
    .filter((p) => p.kind === "css")
    .map((p) => `${p.selector} { ${importantly(p.declarations)}; }`)
    .join("\n");

  node().textContent = css;
  return css;
};
