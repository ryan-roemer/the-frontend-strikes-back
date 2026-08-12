/* global document:false */

/**
 * The chat's own stylesheet: the one edit channel React cannot touch.
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
 */

const ELEMENT_ID = "chat-patch-sheet";

const node = () => {
  let el = document.getElementById(ELEMENT_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = ELEMENT_ID;
    el.dataset.source = "chat";
    document.head.append(el);
  }
  return el;
};

/**
 * Rebuild the sheet from the CSS patches in the log.
 *
 * Declarations get `!important` appended unless they already carry it -- see the
 * react-spring note above. Patches are grouped per selector in log order, so a
 * later edit to the same property simply wins by appearing later.
 */
export const render = (patches) => {
  const css = patches
    .filter((patch) => patch.kind === "css")
    .map(({ selector, declarations }) => {
      const decls = declarations
        .split(";")
        .map((decl) => decl.trim())
        .filter(Boolean)
        .map((decl) =>
          /!important$/i.test(decl) ? decl : `${decl} !important`,
        )
        .join("; ");
      return `${selector} { ${decls}; }`;
    })
    .join("\n");

  node().textContent = css;
};

/** Remove the sheet entirely. Only used when tearing the chat down. */
export const teardown = () => {
  document.getElementById(ELEMENT_ID)?.remove();
};
