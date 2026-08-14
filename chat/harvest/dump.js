/* global console:false, document:false, navigator:false, requestAnimationFrame:false, window:false, URLSearchParams:false */

/**
 * The two ways to look at the harvest.
 *
 *   window.deckDump.markdown()   the document, as a string
 *   window.deckDump.slides()     the structured harvest
 *   window.deckDump.log()        both, to the console
 *   ?dump                        the document, on screen
 *
 * Installed by `mountChat()`, which is why there is no `import()` for it in
 * `index.html`: the assistant is meant to come out in three edits that go
 * together, and a fourth entry point would have made that comment a lie.
 *
 * NO REACT HERE, on purpose. The overlay is built with `createElement` and
 * appended to `<body>`, so it shares nothing with the deck's tree -- a debug
 * surface that could disturb what it is inspecting would be worse than no debug
 * surface. Same reasoning that put the chat on its own root: see the comment on
 * `mountChat()` in `chat/index.js`.
 *
 * THE DECK STAYS MOUNTED. The overlay covers it rather than replacing it,
 * because the fiber tree IS the source -- unmounting the deck to show its own
 * dump would leave nothing to dump.
 */
import {
  deckMarkdown,
  deckReady,
  harvestDeck,
  harvestSlide,
  resolveNode,
} from "./index.js";
import { locate } from "./locate.js";
import { provenanceOf, provenanceReport } from "./provenance.js";
import {
  contextFor,
  describeNode,
  nodeIndex,
  outline,
  position,
  slideView,
} from "./views.js";

const PARAM = "dump";
const OVERLAY_ID = "deck-dump";

/**
 * How long to wait for React to commit.
 *
 * `installDump()` runs from a `.then()` on a dynamic import, which lands before
 * `createRoot().render()` has finished its work -- harvesting there reads an
 * empty tree and quietly falls back to the DOM. Polling frames rather than
 * guessing a timeout: the deck also has to fetch three `examples/` files before
 * the code slides exist.
 */
const MAX_FRAMES = 120;

const whenReady = (fn, frames = 0) => {
  if (deckReady() || frames >= MAX_FRAMES) {
    fn(deckReady());
    return;
  }
  requestAnimationFrame(() => whenReady(fn, frames + 1));
};

const style = (el, declarations) => {
  Object.assign(el.style, declarations);
  return el;
};

const button = (label, onClick) => {
  const el = document.createElement("button");
  el.textContent = label;
  el.addEventListener("click", onClick);
  return style(el, {
    font: "inherit",
    padding: "4px 12px",
    color: "#e6f2ea",
    background: "#243b32",
    border: "1px solid #3d6154",
    borderRadius: "4px",
    cursor: "pointer",
  });
};

/**
 * Render the document over the deck.
 *
 * Deliberately unstyled beyond what makes a long document readable and
 * scrollable. This is a view of text, and any effort spent making it look like
 * the deck would be effort spent hiding whether the text is right.
 */
const overlay = (markdown, slideCount, source) => {
  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  style(host, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483000",
    display: "flex",
    flexDirection: "column",
    background: "#0e1a16",
    color: "#e6f2ea",
    font: "14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
  });

  const bar = style(document.createElement("div"), {
    display: "flex",
    gap: "16px",
    alignItems: "center",
    padding: "10px 16px",
    borderBottom: "1px solid #23372f",
    flex: "0 0 auto",
  });

  const status = document.createElement("span");
  status.textContent = `${slideCount} slides · ${markdown.length.toLocaleString()} chars · ${source}`;

  const copy = button("Copy", async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      copy.textContent = "Copied";
    } catch {
      // Clipboard access needs a permission this page may not have. Selecting
      // the `<pre>` still works, so say so rather than failing silently.
      copy.textContent = "Select and copy";
    }
  });

  const close = button("Close", () => host.remove());

  bar.append(status, copy, close);

  const pre = document.createElement("pre");
  pre.textContent = markdown;
  style(pre, {
    margin: "0",
    padding: "16px",
    flex: "1 1 auto",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  });

  host.append(bar, pre);
  return host;
};

/**
 * Attach the console handles, and draw the overlay if asked for.
 *
 * Nothing is harvested at install time. The handles are lazy so a normal deck
 * load pays nothing for them, and `?dump` is the only path that walks 35 slides
 * without being asked to.
 */
export const installDump = () => {
  const root = document.documentElement;

  // Paged output has no viewport and no business carrying an overlay. `theme.js`
  // sets `paged-mode` for both `?exportMode` and `?printMode`; a `position:
  // fixed` overlay already cost this deck a phantom page once -- see the same
  // guard at the top of `mountChat()`.
  if (
    root.classList.contains("paged-mode") ||
    root.classList.contains("print-mode")
  ) {
    return;
  }

  window.deckDump = {
    markdown: deckMarkdown,
    slides: () => harvestDeck().slides,
    deck: harvestDeck,

    // --- Addressing -------------------------------------------------------
    //
    // The handles the deck's own use cases need, in the order you would reach
    // for them: what is addressable, what one address names, and where that
    // thing came from.
    nodes: () => nodeIndex(),

    // `node` hands back the LIVE thing -- fiber and element -- for poking at in
    // the console. `where` hands back a POINTER, and is JSON-safe on purpose:
    // it is the one you paste into an editor or an agent, and a DOM node in the
    // payload would make `JSON.stringify` throw at exactly that moment.
    node: resolveNode,

    // `locate` is the human-facing end of addressing: say what you mean, get the
    // node or an honest "which of these". `describe` is the other direction --
    // read an id back as a sentence, before anything acts on it.
    locate,
    describe: describeNode,

    where: async (id) => {
      const node = resolveNode(id);
      if (!node) return null;

      const { element, ...pointer } = node;
      return {
        ...pointer,
        provenance: await provenanceOf(node, harvestSlide(node.slide)),
        element: element
          ? { tag: element.tagName.toLowerCase(), className: element.className }
          : null,
      };
    },
    provenance: async () => provenanceReport(harvestDeck().slides),

    // --- Views ------------------------------------------------------------
    //
    // `context` is the one to look at: it runs the same selection rule a turn
    // would and shows both the text and its size, which is the only way to see
    // that "go to the last slide" costs 20 tokens and "find every TODO" costs
    // 1,700.
    context: contextFor,
    views: { position, outline, slide: slideView, index: nodeIndex },

    log: () => {
      const deck = harvestDeck();
      console.log(
        `[harvest] ${deck.slides.length} slides via ${deck.meta.source}`,
      );
      console.log(deckMarkdown());
      return deck;
    },
  };

  if (!new URLSearchParams(window.location.search).has(PARAM)) return;

  whenReady((ready) => {
    if (!ready) {
      console.warn("[harvest] no Slide fibers found; dumping from the DOM");
    }
    if (document.getElementById(OVERLAY_ID)) return;
    const deck = harvestDeck();
    document.body.append(
      overlay(deckMarkdown(deck), deck.slides.length, deck.meta.source),
    );
  });
};
