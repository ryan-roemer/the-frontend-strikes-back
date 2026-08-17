/**
 * The live code editor, behind a lazy boundary.
 *
 * Split out of `components.js` so that `react-live` and `prism-react-renderer` are named by
 * a dynamic `import()` rather than a static one. They are the two heaviest things the deck
 * pulls after Spectacle -- `react-live` carries the sucrase transpiler, and between them
 * they cost ~17 requests and ~130 KB -- and no slide renders this component today, so on a
 * normal load none of it is fetched at all.
 *
 * `export default` because `lazy()` requires it. The gate lives in `components.js`, which is
 * the same arrangement `chat/tools/gate.js` uses and for the same reason: `lazy()` needs a
 * statically analysable specifier, so the boundary and the component cannot share a module.
 *
 * Honest limit: Spectacle mounts every slide into a portal up front, so the moment a slide
 * DOES use this, the chunk loads during the first render anyway. That is exactly what an
 * eager import already did, so this is never worse -- it just stops charging for a
 * component nothing renders.
 */
import { createElement } from "react";
import htm from "htm";
import { LiveEditor, LivePreview, LiveError, LiveProvider } from "react-live";
import { themes } from "prism-react-renderer";

const html = htm.bind(createElement);

// Set `noInline` for imperative snippets (e.g. registering a WebMCP tool). Without it,
// react-live requires the last expression to be renderable.
const CodeEditor = ({
  code,
  noInline = false,
  editorHeight = "400px",
  previewHeight = "50px",
}) => html`
  <${LiveProvider}
    code=${code}
    language="javascript"
    theme=${themes.vsDark}
    noInline=${noInline}
  >
    <div className="code-editor-container">
      <${LiveEditor}
        className="react-live-editor"
        style=${{
          minHeight: editorHeight,
          maxHeight: editorHeight,
        }}
      />
      <${LiveError}
        className="react-live-error"
      />
      <${LivePreview}
        className="react-live-preview"
        style=${{
          minHeight: previewHeight,
          maxHeight: previewHeight,
        }}
      />
    </div>
  </${LiveProvider}>
`;

export default CodeEditor;
