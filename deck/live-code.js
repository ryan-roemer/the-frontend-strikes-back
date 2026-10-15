/**
 * An editable code pane: react-live's `Editor`, dressed to match `CodePane`.
 *
 * Behind a lazy boundary for the same reason as `code-editor.js`, and it is the
 * same chunk: `react-live` and `prism-react-renderer`. Only the `Editor` is used --
 * no `LiveProvider`, so react-live never evaluates anything. Running the code is
 * `RunOutput`'s job, on click.
 *
 * THE THEME IS SPECTACLE'S OWN. `CodePane` renders with `codePaneThemes.vsDark`, a
 * react-syntax-highlighter style object keyed by token type; prism-react-renderer
 * takes the same colours as `{ plain, styles: [{ types, style }] }`. Converting it
 * keeps an editable slide the same colours as its neighbours. The two highlighters
 * tokenize slightly differently, so a word here and there can still differ.
 *
 * Line numbers come from CSS counters on `.token-line` (see `styles.css`), so the
 * speaker notes can keep saying "line 3".
 */
import { createElement, useLayoutEffect, useState } from "react";
import htm from "htm";
import { Editor } from "react-live";
import { codePaneThemes } from "spectacle";
import { theme } from "./theme.js";

const html = htm.bind(createElement);

// `plain` is applied to the `pre` AND to every line's `span`, so it carries type
// and colour only. The theme's `padding: 1em` and `margin` there would indent
// each line and add height; layout stays with `.code-frame pre` in styles.css.
const fromCodePane = (style) => {
  const { color, background, fontFamily, textShadow, lineHeight } =
    style['pre[class*="language-"]'];
  return {
    plain: {
      color,
      background,
      fontFamily,
      textShadow,
      lineHeight,
      fontSize: theme.fontSizes.monospace,
    },
    styles: Object.entries(style)
      // Bare token types only: `comment`, `keyword`. Selectors like
      // `.language-css .token.string` have no prism-react-renderer equivalent.
      .filter(([key]) => /^[a-z-]+$/.test(key))
      .map(([type, value]) => ({ types: [type], style: value })),
  };
};

const THEME = fromCodePane(codePaneThemes.vsDark);

/**
 * ONE RE-RENDER RIGHT AFTER MOUNT, or the first keystroke drops focus.
 *
 * `use-editable` (inside `Editor`) lists `ref.current` in its setup effect's deps,
 * read during render -- so `null` on the first render and the `pre` on the
 * second. That second render re-runs the effect: its cleanup removes
 * `contenteditable`, which blurs the editor, and its `focus()` runs before the
 * attribute is back, so it doesn't take. Left alone, the second render is the
 * first edit: one character lands and focus goes to `<body>`. Measured on
 * react-live 5.0.0 / use-editable 2.3.3. Forcing it here, before anyone has
 * clicked in, spends the re-run while nothing is focused.
 */
const LiveCode = ({ code, language, onChange }) => {
  const [, settle] = useState(false);
  useLayoutEffect(() => settle(true), []);

  return html`
    <${Editor}
      className="live-code"
      code=${code}
      language=${language}
      theme=${THEME}
      onChange=${onChange}
    />
  `;
};

export default LiveCode;
