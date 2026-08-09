/**
 * React 19 compat shim for Spectacle's Markdown pipeline.
 *
 * `hast-to-hyperscript@9` detects React by checking a probe element for `_owner`/`_store`,
 * which React 19 removed. When that check fails it emits a string `style`, and React 19
 * throws on those (error #62). Restoring the marker is enough. Nothing reads `_store`.
 *
 * Full explanation, and the rehype-react@8 alternative: docs/dependencies.md
 *
 * COMPAT REQUIREMENT: bare "react" must resolve to upstream React, not to this file, or
 * this module imports itself. The import map scopes this shim to Spectacle alone.
 */
import * as React from "react";

export * from "react";

export const createElement = (...args) => {
  const element = React.createElement(...args);
  try {
    if (element && typeof element === "object" && !("_store" in element)) {
      Object.defineProperty(element, "_store", {
        value: {},
        enumerable: false,
      });
    }
  } catch {
    // React freezes elements in its development build. The sniff fails there too, but
    // development React only warns about the string `style` rather than throwing.
  }
  return element;
};

// Required: Spectacle default-imports React alongside its named imports, so omitting this
// fails module linking with "does not provide an export named 'default'".
export default new Proxy(React.default, {
  get: (target, prop) =>
    prop === "createElement" ? createElement : target[prop],
});
