import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * The browser globals this deck actually uses.
 *
 * SPELLED OUT RATHER THAN `globals.browser`, deliberately. The `globals` package would
 * bring 700-odd names for the sake of the two dozen below, and it would be a dependency
 * added for nothing but lint config -- this repo's whole claim is that it has no build
 * step and a short dependency list, and `docs/dependencies.md` accounts for every entry.
 *
 * DECLARED ONCE, HERE. Every file under `chat/` and `deck/` used to carry its own
 * hand-maintained `/* global setTimeout:false, document:false, … *\/` header -- 29 of
 * them, each a list somebody had to remember to extend when they used a new browser API.
 * They were noise that looked like information, and the failure mode was a lint error for
 * using `matchMedia` rather than anything about the code.
 *
 * Adding a name here when you reach for a new API is the cost, and it is the right one:
 * an explicit list is a readable statement of what this code assumes the platform has.
 */
const BROWSER = [
  "AbortController",
  "CSS",
  "DOMException",
  "MutationObserver",
  "NodeFilter",
  "Response",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "caches",
  "clearInterval",
  "clearTimeout",
  "console",
  "document",
  "fetch",
  "getComputedStyle",
  "getSelection",
  "localStorage",
  "location",
  "matchMedia",
  "navigator",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "setInterval",
  "setTimeout",
  "window",
  // Chrome's Prompt API. Not a standard global anywhere yet, and its absence is the whole
  // point of the provider that uses it -- `chrome.js` feature-detects rather than assuming.
  // Listing it here only tells the linter the name is intentional.
  "LanguageModel",
];

export default [
  {
    ignores: [".data/*"],
  },
  js.configs.recommended,
  eslintConfigPrettier,
  {
    // Everything the deck *ships* is browser code -- no build step, no bundler, no Node.
    files: ["chat/**/*.js", "deck/**/*.js", "examples/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries(BROWSER.map((name) => [name, "readonly"])),
    },
  },
  {
    // `scripts/` is the exception: authoring tools that run under Node and write
    // committed assets. Nothing here is loaded by the deck at runtime.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  {
    // `test/` runs under `node --test`. `URL` is the only platform name it needs, for
    // resolving a fixture against `import.meta.url` -- there is no `__dirname` in ESM and
    // no reason to add a path dependency for one join.
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        URL: "readonly",
        console: "readonly",
        // `cdp.js` is two fetches and a socket, with no dependency to hide them behind.
        WebSocket: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        // Paired with `setTimeout`: every CDP call is bounded by a timer that has to be
        // cleared on the winning path, or a successful run holds the event loop open for
        // the remainder of each call's budget.
        clearTimeout: "readonly",
      },
    },
  },
];
