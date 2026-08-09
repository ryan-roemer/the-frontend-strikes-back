/**
 * React 19 compatibility shim for Spectacle's Markdown pipeline.
 *
 * Spectacle renders Markdown through `rehype-react@6` -> `hast-to-hyperscript@9`, which
 * decides whether it is talking to React by calling the element factory with a single
 * argument and sniffing the result:
 *
 *     function (t) {
 *       var r = t && t("div");
 *       return !!(r && ("_owner" in r || "_store" in r) && r.key == null);
 *     }
 *
 * React 19 removed both `_owner` and `_store` from elements. The sniff therefore fails,
 * hast-to-hyperscript falls back to plain-hyperscript mode, and it emits raw DOM attribute
 * names -- `class` instead of `className`, and a *string* `style` instead of an object.
 * React 18 tolerated that silently in production; React 19 throws on a string `style`
 * (error #62), so every Markdown slide takes the whole deck down with it.
 *
 * Re-exporting React with a `createElement` that restores the marker is enough to put
 * hast-to-hyperscript back into React mode. Nothing reads `_store` at runtime -- it exists
 * only to be sniffed.
 *
 * Delete this once Spectacle moves to `rehype-react@8`, which uses
 * `hast-util-to-jsx-runtime` and has no such sniff.
 */

// COMPAT REQUIREMENT: the bare "react" specifier must resolve to upstream React, NOT to
// this file, or this module would import itself. That is why the import map points "react"
// at the CDN and routes only Spectacle's own baked-in react URL here -- Spectacle is the
// sole consumer that needs the patch. Do not remap "react" to this file.
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

export default new Proxy(React.default, {
  get: (target, prop) =>
    prop === "createElement" ? createElement : target[prop],
});
