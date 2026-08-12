# Dependencies

This deck has **no build step**. Every dependency is a native ES module loaded from
[jsDelivr](https://www.jsdelivr.com/) and wired up by the import map in
[`index.html`](../index.html). There is no `node_modules` at runtime, no bundler, and no
lockfile for the browser graph — the import map _is_ the lockfile.

That buys a lot of simplicity and costs some sharp edges. This document is the map of those
edges: how the pinning works, what broke on the way to React 19, what was deliberately left
alone, and how to verify a change before you present with it.

---

## 1. How jsDelivr `+esm` works

Requesting `https://cdn.jsdelivr.net/npm/<pkg>@<version>/+esm` gives you an ESM bundle. The
important detail:

> jsDelivr **externalizes each package's `dependencies` and `peerDependencies`** as absolute
> `/npm/<dep>@<resolved-version>/+esm` URLs baked into the bundle.

Two consequences drive everything else here:

1. **You only need bare entries for what the deck imports directly.** Spectacle's own deps
   (`styled-components`, `kbar`, `unified`, `react-syntax-highlighter`, …) resolve themselves.
   This is why the map is short despite ~870 modules loading.
2. **Transitive versions are frozen into the bundle at build time**, and the only lever you
   have over them is rewriting those URLs with import map prefix remaps. jsDelivr resolves
   ranges when it builds, so two packages depending on `react@^19` can easily bake in
   _different_ patch versions.

---

## 2. The three jobs the import map does

### Bare specifiers

Ordinary aliases for what the deck imports: `react`, `spectacle`, `htm`, and friends.

### Prefix remaps (keys ending in `/`)

```json
"https://cdn.jsdelivr.net/npm/react@19.2.7/": "https://cdn.jsdelivr.net/npm/react@19.2.8/"
```

These rewrite the baked-in URLs. They do two things:

- **Collapse every React copy onto one.** React _must_ be a singleton or hooks fail with
  "invalid hook call" / "Cannot read properties of null (reading 'useMemo')".
- **Drag Spectacle's pinned deps forward** onto React 19-compatible releases.

### Scopes

```json
"scopes": {
  "https://cdn.jsdelivr.net/npm/spectacle@10.2.3/": {
    "https://cdn.jsdelivr.net/npm/react@19.2.0/+esm": "./deck/react-compat.js"
  }
}
```

A scope key matches on the **importer's** URL, so this hands the compat shim to Spectacle and
nobody else. See [§5](#5-the-react-19-compat-shim).

### Resolution rules worth remembering

- Keys that **end in `/`** are prefix matches; anything else is an **exact** match.
- Longer keys win. An exact `…/react@19.2.0/+esm` entry beats a `…/react@19.2.0/` prefix
  entry, which is how the scoped shim coexists with the jsx-runtime remap.
- Import maps remap **URL-like specifiers too**, not just bare ones. That is the entire basis
  of the prefix-remap technique.
- Import maps change **which module a specifier resolves to**. They cannot change code inside
  a module, and they cannot change the **arguments one module passes to another**. Most of the
  dead ends in [§6](#6-things-deliberately-not-upgraded) are this rule biting.

---

## 3. Current pins

| Package                          | Pin           | Notes                                                                                   |
| -------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `react`, `react-dom`, `react-is` | 19.2.8        | Every other copy in the graph remaps here                                               |
| `spectacle`                      | 10.2.3        | **Required** for React 19 — see below                                                   |
| `styled-components`              | 6.5.1         | Forced over Spectacle's `^5.3.6`; needs the bridge in [§5](#5-the-react-19-compat-shim) |
| `react-spring`                   | 10.0.4        | Forced over Spectacle's `^9.5.5`                                                        |
| `kbar`                           | 0.1.0-beta.48 | Forced over Spectacle's pinned `beta.40`                                                |
| `react-syntax-highlighter`       | 16.1.1        | Forced over Spectacle's `^15.5.0`                                                       |
| `react-live`                     | 4.1.8         | Latest                                                                                  |
| `prism-react-renderer`           | 2.4.1         | `2.4.0` (pulled by react-live) remaps here                                              |
| `htm`                            | 3.1.1         | Latest                                                                                  |
| `styled-system`                  | 5.1.5         | Latest — see [§6](#6-things-deliberately-not-upgraded)                                  |
| `use-resize-observer`            | 9.1.0         | Deliberately **not** bumped — see [§6](#6-things-deliberately-not-upgraded)             |
| `@emotion/is-prop-valid`         | 1.4.0         | Only for the styled-components v6 bridge                                                |
| `@litert-lm/core`                | 0.15.0        | The deck assistant's on-device model. Loads a wasm runtime — see below                  |

### `@litert-lm/core` and its wasm

The only dependency the deck loads for a reason other than rendering slides: it runs Gemma 4
on the GPU for the assistant in [`chat/`](../chat/). Two things about it are unlike everything
else in this table.

**It fetches a wasm runtime separately from its JavaScript, and the two must match.** The
reference implementation this was ported from keeps a second hardcoded URL next to its import
map entry, with a "bump both together" comment — a rule that works right up until somebody
forgets. This deck derives it instead, so the claim at the top of this document stays true and
there is exactly one pin:

```js
// chat/agent/providers/litert.js
const LITERT_WASM_URL = new URL(
  "./wasm",
  import.meta.resolve("@litert-lm/core"),
).href;
```

`import.meta.resolve` returns the import-map-resolved URL, and `+esm` sits at the package root
alongside `wasm/`, so `./wasm` lands on the right directory. It shipped in Chrome 105, Firefox
106 and Safari 16.4 — all far older than any browser with WebGPU, so every browser that can
run the model at all has it. The derivation asserts the resolved URL still looks like a
versioned jsDelivr path, because the one thing it couples to is that URL _layout_: repointing
this entry at another CDN, or at a `/dist/index.mjs`-style path, would otherwise silently
derive a wrong `./wasm`.

**It is the deck's only lazily-loaded dependency.** Nothing above is fetched until a presenter
asks for it: `mountChat()` imports the chat dynamically, and the wasm and the ~2 GB model come
later still, on an explicit click. A deck presented without ever opening the assistant pays
nothing for it.

**The model is not a dependency in this table's sense.** `gemma-4-E2B-it-web.litertlm` is
2,008,432,640 bytes, fetched from HuggingFace on first use and cached in the Cache API. It is
version-pinned by repo and filename in `chat/agent/providers/litert.js`, verified by exact byte
count on both write and read, and deletable from the panel's info modal. **Downloading it is a
pre-flight step for a talk, not a detail** — do it on a connection you trust, then confirm the
status row says "on disk" before you go anywhere near a stage.

`spectacle@10.2.1` **cannot** run on React 19: it sets `defaultProps` on function components
in 19 places, which React 19 removed support for. `10.2.3` has zero (`curl …/+esm | grep -c
'\.defaultProps'`).

---

## 4. The React singleton rule

Non-negotiable: exactly one `react` and one `react-dom` instance. Bumping _any_ transitive dep
can introduce a new React version and silently break this — during the React 19 work,
`@react-spring/core@10.1.2` dragged in `react@19.2.7`, `react-syntax-highlighter@16` brought
`19.2.4`, and `kbar@beta.48` brought `19.1.0` via Radix. Each one needs its own remap line.

Hand-enumerating versions does not survive a dependency bump. Use the audit script in
[§8](#8-verifying-a-change).

Verify in the browser console by **hook identity**, not module default (`react-compat.js`
exports a Proxy, so `default` comparisons give false negatives):

```js
(await import("https://cdn.jsdelivr.net/npm/react@19.2.0/+esm")).useState ===
  (await import("react")).useState; // must be true
```

---

## 5. The React 19 compat shim

[`deck/react-compat.js`](../deck/react-compat.js) exists for one reason.

Spectacle renders Markdown through `rehype-react@6` → `hast-to-hyperscript@9`, which decides
whether it is talking to React by sniffing a probe element:

```js
function (t) {
  var r = t && t("div");
  return !!(r && ("_owner" in r || "_store" in r) && r.key == null);
}
```

React 19 removed **both** `_owner` and `_store`. The sniff fails, hast-to-hyperscript falls
back to plain-hyperscript mode, and emits raw DOM attribute names — `class` instead of
`className`, and a **string** `style` instead of an object. React 18 tolerated that silently in
production; React 19 throws on a string `style`
([error #62](https://react.dev/errors/62)), so every Markdown slide takes the whole deck down.

The shim re-exports React with a `createElement` that restores the marker. Nothing reads
`_store` at runtime — it exists only to be sniffed.

**Why it is scoped to Spectacle and not to the offenders:** scopes match the _importer_, and
neither `rehype-react` nor `hast-to-hyperscript` imports React at all. They only call the
factory Spectacle hands them at runtime. Spectacle is the module that does
`import { createElement } from "react"`, so it is the only scope that can work.

**COMPAT REQUIREMENT:** the bare `"react"` specifier must keep pointing at the CDN, _not_ at
`react-compat.js`, or the shim would import itself. This is why the map is arranged with
`"react"` → upstream and only Spectacle's baked-in `react@19.2.0/+esm` → the shim.

### The styled-components v6 bridge

Separate problem, same era. v5 filtered non-HTML props out with `@emotion/is-prop-valid` before
they reached the DOM. v6 dropped that in favour of transient (`$`-prefixed) props — but
Spectacle is written against v5, so without a bridge every styled-system prop it uses lands on
the element as a bogus HTML attribute. Measured on one slide: **464 leaked attributes**
(`padding` ×106, `margin` ×157, `textalign` ×72, …).

The fix is the `StyleSheetManager shouldForwardProp` wrapper at the deck root in `index.html`,
straight from the v6 migration docs. Back to 0 leaked props.

Note that **styled-components v5 also runs fine on React 19** once the shim is in place, with
zero leakage and no bridge needed. v6 was chosen because v5 is EOL and v6 drops `@emotion/*`,
`hoist-non-react-statics`, and `shallowequal` from the graph. Dropping the v6 remap and the
bridge together is a valid, smaller-surface fallback.

---

## 6. Things deliberately NOT upgraded

| Package                          | Why not                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `use-resize-observer` → 10       | v10 **dropped its default export** (only exports `useResizeObserver`), and Spectacle does `import useResizeObserver from "use-resize-observer"`. Remapping yields `undefined`.                                                                                                                                                                                     |
| `styled-system`                  | 5.1.5 **is** the latest (Feb 2020, unmaintained). It has no React dependency at all, so React 19 does not affect it. Nothing to update.                                                                                                                                                                                                                            |
| `hast-to-hyperscript` → 10 / 11  | v10 still contains the same `_owner`/`_store` sniff, _and_ changed its export shape (v9 exports `default`, v10 exports named `toH`), so `rehype-react@6`'s interop unwrap breaks with `a is not a function`. v11 is an empty deprecation stub — 404 on `+esm`, no `main`, just "use `hast-util-to-jsx-runtime` instead".                                           |
| `rehype-react` → 7               | Needs `unified@^10`; Spectacle runs `unified@9`. Remapping unified cascades into `remark-parse@8`, `remark-rehype@7`, and `rehype-raw@5`, which all expect unified@9's default export.                                                                                                                                                                             |
| `rehype-react` → 8 (plain remap) | The only sniff-free path, but it wants `{ Fragment, jsx, jsxs }` while Spectacle passes `{ createElement, components }` — and that object literal lives inside Spectacle's minified bundle, where no import map can reach. It also sets `this.compiler` (unified 11) where unified@9 reads `this.Compiler`. Fails with ``Cannot `stringify` without `Compiler` ``. |

---

## 7. Alternatives explored (and kept on the shelf)

### A rehype-react@8 adapter — works, not adopted

A ~10-line adapter _does_ successfully upgrade Spectacle's Markdown pipeline, and makes
`react-compat.js` unnecessary entirely (verified: renders clean with the shim deleted).

```js
// deck/rehype-react-compat.js
import rehypeReact8 from "https://cdn.jsdelivr.net/npm/rehype-react@8.0.0/+esm";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";

export default function rehypeReactCompat(options = {}) {
  rehypeReact8.call(this, {
    Fragment: options.Fragment ?? Fragment,
    jsx,
    jsxs,
    components: options.components,
  });
  this.Compiler = this.compiler; // unified@9 protocol
}
```

Wired in by swapping one scope entry:

```json
"https://cdn.jsdelivr.net/npm/rehype-react@6.2.1/+esm": "./deck/rehype-react-compat.js"
```

**Why it is not the default:** it is more principled — `hast-util-to-jsx-runtime` has no sniff
at all, so it fixes the root cause rather than feeding the sniff what it wants. But it swaps a
core rendering package inside Spectacle for a major version Spectacle has never been tested
against, and hand-bridges a plugin protocol across two `unified` majors. It also renders 16
fewer DOM nodes per slide (visually identical, text length identical — almost certainly
whitespace text nodes, but it _is_ a behavior delta). For a conference deck, keeping
Spectacle's own shipped-and-tested pipeline plus one inert property is the smaller risk.

### Staying on React 18

The only configuration needing **no local shim at all**. React 18.3.1 + `spectacle@10.2.1` +
`styled-components@5.3.11` was verified green before the React 19 work. If the shim ever
becomes a liability, this is the fallback.

### Upstream fix

The real resolution is Spectacle moving to `rehype-react@8` /
`hast-util-to-jsx-runtime`. That would delete `deck/react-compat.js` and its scope entry
outright. Worth an issue on
[FormidableLabs/spectacle](https://github.com/FormidableLabs/spectacle).

---

## 8. Verifying a change

### Audit the graph for duplicate stateful packages

Anything that holds state (React, react-dom, styled-components, react-spring) must be a single
copy. This script crawls the jsDelivr graph the way the browser will, applying remaps as it
goes, and prints the remap lines you are missing:

```js
// audit-deps.mjs -- run with: node audit-deps.mjs
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const map = JSON.parse(
  html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/)[1],
);
const prefixes = Object.entries(map.imports)
  .filter(([k]) => k.startsWith("https://") && k.endsWith("/"))
  .sort((a, b) => b[0].length - a[0].length);
const resolve = (url) => {
  for (const [k, v] of prefixes)
    if (url.startsWith(k)) return v + url.slice(k.length);
  return url;
};

const seen = new Map();
const queue = Object.entries(map.imports)
  .filter(([k]) => !k.startsWith("https://"))
  .map(([, v]) => resolve(v))
  .filter((u) => u.startsWith("https://"));
const RE = /(?:from|import)\s*\(?\s*"(\/npm\/[^"]+)"/g;

while (queue.length) {
  await Promise.all(
    queue.splice(0, 16).map(async (u) => {
      if (seen.has(u)) return;
      seen.set(u, true);
      const res = await fetch(u);
      if (!res.ok) return console.log(`HTTP ${res.status} ${u}`);
      for (const m of (await res.text()).matchAll(RE)) {
        const kid = resolve("https://cdn.jsdelivr.net" + m[1]);
        if (!seen.has(kid)) queue.push(kid);
      }
    }),
  );
}

const byPkg = new Map();
for (const u of seen.keys()) {
  const m = u.match(/\/npm\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/);
  if (!m) continue;
  byPkg.set(m[1], (byPkg.get(m[1]) ?? new Set()).add(m[2]));
}

console.log(`crawled ${seen.size} modules`);
for (const name of [
  "react",
  "react-dom",
  "styled-components",
  "react-spring",
]) {
  const vs = [...(byPkg.get(name) ?? [])];
  console.log(vs.length === 1 ? `OK   ${name}: ${vs}` : `DUPE ${name}: ${vs}`);
}
```

Current state: **872 modules**, all four stateful packages single-copy.

### Exercise the deep parts of the graph

`npm run dev`, then check the features that reach furthest — these are what a bad remap breaks:

- **Title slide** — styled-components + styled-system theming
- **"Hi!" slide** — `react-spring` `Appear` stepping; also try `?animate=false`
- **Markdown slide sets** — the `unified`/`remark`/`rehype` chain. Confirm `em()` text is
  **teal** and Phosphor icons render; that is the direct tell for the
  [§5](#5-the-react-19-compat-shim) sniff
- **`JsSlide` code slides** — `react-syntax-highlighter` + the deep `vs-dark` style import
- **"Live edit" slide** — `react-live` + `sucrase` + `prism-react-renderer`; type in it
- **`Cmd/Ctrl+K`** — `kbar` + Radix + `react-virtual`
- **`?presenterMode=true`** — `broadcast-channel` + `history` + `query-string`
- **Console must be empty**, and DevTools should show no leaked lowercase DOM attributes
  (`padding`, `textalign`, …) on real elements

---

## 9. Gotchas

**jsDelivr `Link: rel=modulepreload` headers bypass the import map.** You will see old React
versions in the network tab even when the dedupe is working perfectly. Preloads are URL
fetches, not specifier resolutions, so they skip remapping. Those bytes are downloaded but
never instantiated — wasted preload, not a second React. Confirm with the hook-identity check
in [§4](#4-the-react-singleton-rule) rather than trusting the network panel.

**…and the same headers produce a harmless 404 in the console.** `@litert-lm/core`'s bundle
serves `Link: </npm/@litertjs/wasm-utils@2.5.3/+esm>; rel=modulepreload`. Browsers resolve
`Link` headers against the **document** URL rather than the module's, so the browser requests
`<origin>/npm/@litertjs/wasm-utils…` from the dev server and gets a 404. The real import inside
the bundle resolves against `cdn.jsdelivr.net` and works fine. Worth knowing precisely because
this deck is a talk about the browser and somebody in the audience will have devtools open:
it is a wasted preload, not a broken dependency.

**LiteRT's C++ runtime logs to `console.error`.** Creating the engine emits six lines that look
alarming and are not — `INFO: [environment.cc:36] Creating LiteRT environment…`, a `WARNING`
about the NPU accelerator not registering, and accelerator registrations. They are the
runtime's own log levels written to the error channel, they appear only when the engine is
built, and there is no option to silence them. Filter them out (`/^(INFO|WARNING|ERROR):\s*\[/`)
before concluding a "zero console errors" check has failed.

**Production builds strip React's warnings.** jsDelivr serves `NODE_ENV=production`, so
developer warnings simply do not appear. The `class`/`style` bug above was silently wrong under
React 18 for exactly this reason. When something is mysterious, temporarily point the map at
esm.sh dev builds to get real messages and component stacks:

```json
"react": "https://esm.sh/react@19.2.8?dev",
"react-dom/client": "https://esm.sh/react-dom@19.2.8/client?dev&external=react"
```

You also need exact-URL entries redirecting each baked-in `…/react@<v>/+esm` to the dev build,
or you will end up with two Reacts and a different error than the one you are chasing.

**Never target styled-components generated class names.** Selectors like `.sc-iHGNWf` or
`.enpNOd` are hashed from component order and the library version. They change on any
styled-components bump and fail **silently** — the CSS simply stops matching, with no error
anywhere. The v5 → v6 move in this repo killed two such overrides exactly that way, and the
code panes quietly rendered at the wrong size until someone diffed the computed styles.

Reach for a theme value first (`theme.fontSizes.monospace` sets `CodePane`'s size, which is
what one of those hacks was hand-rolling), then a class you own on a wrapper element. If you
ever truly cannot avoid it, add an assertion for the _computed style_ — not for the selector —
so the failure is loud.

**Failure signatures**, collected the hard way:

| Symptom                                              | Cause                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `Cannot read properties of null (reading 'useMemo')` | Duplicate React — a version is missing from the remaps                   |
| `Minified React error #62` (string `style`)          | The hast-to-hyperscript sniff failed → [§5](#5-the-react-19-compat-shim) |
| `a is not a function`                                | Remapped to a version with a different export shape (named vs default)   |
| ``Cannot `stringify` without `Compiler` ``           | `unified` plugin protocol mismatch (v9 `Compiler` vs v11 `compiler`)     |
| `does not provide an export named 'default'`         | A remap cascaded into packages expecting the old major                   |
| Lowercase junk attributes on DOM nodes               | styled-components v6 without the `shouldForwardProp` bridge              |
| A style override silently stops applying             | It targeted a generated `.sc-*` class that the version bump rehashed     |

**Pin exact versions.** jsDelivr resolves ranges at build time and caches aggressively; a
range in the map means the graph can shift under you between rehearsal and stage.
