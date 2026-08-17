/**
 * Prism-only entry for Spectacle's syntax highlighter.
 *
 * Spectacle does `import { Prism } from "react-syntax-highlighter"` -- the package's MAIN
 * entry, which is the highlight.js build. That entry statically imports all 191
 * highlight.js language modules plus `lowlight` before it re-exports `Prism`, so a deck
 * that only ever renders Prism-highlighted `CodePane`s was paying 194 requests and 476 KB
 * for grammars nothing asks for. Native ESM has no tree shaking, and this repo has no
 * build step to add one, so the fix has to happen at resolution time.
 *
 * `react-syntax-highlighter/prism` is the same `Prism` component reached directly:
 * refractor plus four Babel helpers, no highlight.js. The rename is the whole point --
 * that entry is a DEFAULT export and Spectacle imports a NAMED one.
 *
 * NO VERSION HERE ON PURPOSE. The import map is this repo's lockfile, so it owns the pin
 * and this file only names the specifier. Wiring it up takes two entries there, and they
 * work together:
 *
 *   1. a bare `react-syntax-highlighter/prism` specifier, which is what this file imports
 *   2. an exact-URL key sending Spectacle's `…@15.6.6/+esm` request to this file
 *
 * The exact-URL key wins over the neighbouring `…@15.6.6/` prefix remap because longer keys
 * are matched first. That prefix remap has to stay: Spectacle imports two style modules
 * underneath it, and they still need to land on the pinned version.
 *
 * Full explanation: docs/dependencies.md
 */
export { default as Prism } from "react-syntax-highlighter/prism";
