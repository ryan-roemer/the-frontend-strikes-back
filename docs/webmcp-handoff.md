# The deck as a WebMCP server

The deck registers real WebMCP tools. An agent in a browser side panel can read what is on a slide,
navigate the deck, and — behind a flag — change it.

This is deliberately an **intermediate** step. Wiring the on-device model stacks several unknowns at
once (context placement, the `remember` seam, structured output from a model with no
grammar-constrained decoding). Registering the addressing layer as tools exercises the whole
pipeline with something that already works, so when the 2B model arrives the only new variable is
the model.

It is also the demo the talk deserves. Slide 9 says "the page registers tools, the agent discovers
and calls them." After this, that is not a diagram of somebody else's app.

Read [deck-context-handoff.md](deck-context-handoff.md) first — this consumes everything it built.

---

## 1. The API

```js
export const getModelContext = () =>
  document.modelContext ?? navigator.modelContext;
```

`document` first: it is where the standard is going, `navigator` is the earlier shape. This matches
the code panes on slides 10–12, so the deck and its own examples agree.

Registration follows [`examples/register-tool.js`](../examples/register-tool.js) —
`registerTool({ name, description, inputSchema, execute })` — and results follow
[`examples/tool-handler.js`](../examples/tool-handler.js): `{ content: [{ type: "text", text }] }`,
or `{ isError: true, content: [...] }`. **If those examples and `chat/mcp/tools.js` ever disagree,
the examples are the contract and the code is the bug** — they are on screen while it runs.

With no host present the install is a no-op with one `console.info`, and the tools are still
reachable from `window.deckMcp`.

---

## 2. The tools

| file                 | holds                                                                |
| -------------------- | -------------------------------------------------------------------- |
| `chat/mcp/index.js`  | `getModelContext()`, registration, the `?mcp` gate, `window.deckMcp` |
| `chat/mcp/tools.js`  | the fourteen descriptors                                             |
| `chat/mcp/target.js` | `resolveTarget()` — the id-or-phrase contract                        |
| `chat/nav.js`        | `next` / `prev` / `toSlide` / `first` / `last`                       |

**Read and navigate are always registered. Editing appears only with `?mcp`** — the `?dump`
precedent. An agent connected during the actual talk can follow along and move the deck, and cannot
alter a slide. Measured: 8 tools and no stylesheet on a normal load, 14 with the flag.

| always                                                                                                                         | `?mcp` only                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `get_current_slide` `get_deck_outline` `find_node` `where_is_node` `search_deck` `get_speaker_notes` `go_to_slide` `move_deck` | `edit_node` `style_node` `toggle_node_class` `set_deck_variable` `undo_edit` `reset_edits` |

### The `target` contract

Every tool that names a node takes `target`: **a node id like `9.3`, or a phrase like "the second
bullet"**. Anything matching `^\d+\.\d+$` is an id; everything else goes through `locate()`.

That is what makes "change the second bullet to X" one call when the phrase is unambiguous, while
leaving a precise second call available when it is not. **Ambiguity is a refusal carrying the
candidates, never a pick** — slide 7 says "TODO: session + when" three times and slide 31 says
"TODO" three times, so the case is real, and choosing the first is the one outcome nothing
downstream can recover from.

### Testing without a host

`window.deckMcp = { list(), call(name, args), editing, host }` is installed either way:

```js
await deckMcp.call("find_node", { phrase: "the second bullet" });
await deckMcp.call("go_to_slide", { slide: 21 });
```

Worth having built first. "Are the tools right" and "is the extension connected" fail identically
from the console, and this separates them.

---

## 3. Two bugs this found, both pre-existing

### The harvest dropped slides after any navigation

**`slideFibers()` returned 33 slides instead of 35 once the deck had been navigated.** Slides 2 and
3 vanished, every id from 4 up shifted down by two, and `harvestSlide(9)` returned slide 11's
content — under its own name, with a plausible title, reporting success. Nothing threw.

The cause: the presenter-mode dedup compared `DeckContext` provider fibers with `===`. **React
double-buffers fibers** — every node has a `current` and an `alternate`, and a re-render swaps which
is live for the subtrees it touched. After a navigation some slides' ancestors sit on the new
provider fiber and some still point at the old one, so an identity comparison split one pane in two
and kept only half.

Fixed with `sameFiber()`, which compares through `alternate`.

**Why every previous verification missed it:** on a fresh load nothing has re-rendered, so every
fiber is on its first copy and the identity check happens to hold. The cross-mode signature tests,
the 162-node count, the locate fixtures — all of it ran in the one state where the bug is invisible.
**Navigate before you measure.** It is now in the checklist below.

### Slide 0: three tools, three contracts

Reported from a real session: `find_node({ phrase, slide: 0 })` answered
`"phrase" — no slide on slide 0.` The word salad was the symptom; three separate problems were
underneath it.

**The worst one was silent.** `get_speaker_notes({ slide: 0 })` returned the notes for whatever
slide was on screen, labelled with that slide's number, with nothing to say the request had been
rewritten — `slideNumber()` treated any non-positive integer as "not provided" and fell back to the
current slide. A confidently wrong answer, in the tool whose entire job is to report what someone
planned to say.

**The root cause was a `??`/falsy disagreement,** two lines apart in `locate()`:

```js
const number = slide ?? position().slide; // 0 is "provided"
const harvested = number ? harvestSlide(number) : null; // 0 is "absent"
```

The note `"no slide"` was written for an unreachable deck, and the caller spliced it into a sentence
that already named a slide.

**And the contracts disagreed across tools:** `go_to_slide` clamped, `get_speaker_notes` fell back
to the current slide, `find_node` errored. Same parameter, same concept, three behaviours.

The fix keeps one asymmetry on purpose:

|                | behaviour on an impossible slide                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **navigation** | **clamps**, and says it clamped. "Go to slide 99" plausibly means "go to the end", and it costs a keypress to undo                                                                     |
| **reads**      | **refuse**, naming the range: _"There is no slide 0 — the deck has slides 1 to 35."_ Answering from a different slide is the same sin as `locate()` picking among ambiguous candidates |

That is the risk model already behind the `?mcp` gate: cheap-to-undo actions are forgiving, content
answers are not.

**Slide 0 deserves its own message** rather than a generic rejection. `activeView.slideIndex` really
is 0-based inside Spectacle while everything a person or an agent says about this deck is 1-based,
so passing 0 is a reasonable mistake — the error states the range instead of only refusing, and the
schema now carries `minimum: 1` with the convention spelled out in the description.

### `mainTextNode` moved between rebuilds

Text edits write `nodeValue` on the longest text node in an element. "Longest" is a property of the
_current_ text, so re-deciding it on every `rebuild()` moved the target as soon as an edit changed a
length.

Measured on slide 9's first bullet — `The page **registers** tools. The agent discovers and calls
them.`, two text nodes either side of a `<strong>`. The edit shortened the longer one; the next
rebuild picked the _other_ one as longest, restored the original into it and wrote the replacement
into it too. The bullet rendered as `CHANGEDregistersCHANGED`, and reset could not put it back
because both halves had been overwritten.

Fixed by choosing the node once and addressing it **by index** thereafter — which is what the
deleted `chat/edit/patches.js` did, and what was lost in re-deriving it.

---

## 4. The edit layer

Restored from `ef4c47f^` into `chat/edit/`, deliberately not under `chat/mcp/`: mutating the deck is
not an MCP concern, and when the on-device model is wired both consumers should go through the same
single writer.

| file          | role                                                              |
| ------------- | ----------------------------------------------------------------- |
| `sheet.js`    | the deck-owned `<style>`, regenerated wholesale, all `!important` |
| `patches.js`  | the patch log, baselines, `rebuild()`                             |
| `apply.js`    | the only writer; validation and receipts                          |
| `watchdog.js` | `MutationObserver` → `rebuild()` after a remount                  |

**`chat/edit/locator.js` was not restored, and is not needed.** The deleted version needed a
structural path plus role plus a text snippet because its addresses were `data-chat-ref` attributes
and React drops an attribute it does not own. Node ids come from the fiber tree and `resolveNode`
re-walks on every call, so the address survives the remount that killed the old one.

One DOM hook remains: **CSS needs a selector**, so a styled node gets `data-deck-ref="9.3"` and the
rule targets `[data-deck-ref="9.3"]`. Cleared and re-stamped on every `rebuild()` — stamping without
clearing left an attribute behind after a reset, which is exactly the residue that makes "is the
deck really back to normal?" unanswerable.

### Non-negotiables, all recovered and all measured

1. **Never `textContent` on deck DOM.** It removes nodes React's fiber still references; the next
   commit can throw `NotFoundError` from `removeChild` and unmount the root — a blank deck, mid-talk.
   `nodeValue` on an existing text node and `classList.toggle`, nothing else. (`textContent` on our
   own `<style>` is fine — React has never seen it.)
2. **All styling through the one sheet**, appended last, regenerated wholesale, every declaration
   `!important`. react-spring rewrites each slide wrapper's `style` attribute every frame, so inline
   styles do not survive.
3. **Colour emits two declarations** — `color` and `-webkit-text-fill-color`. The display title is
   gradient-painted with `background-clip: text`, so `color` alone changes the computed value and
   nothing visible.
4. **Ask the browser, don't trust the string.** `CSS.supports(prop, resolvedValue)` before storing,
   and resolve relative font sizes against `getComputedStyle(el).fontSize` first — `font-size:
larger` once took a 46px subtitle to 19.2px because it resolves against the _parent_.
5. **The log is the source of truth; the DOM is its projection.** Undo pops and rebuilds — restore
   baselines, regenerate the sheet, replay in order — never inverses.
6. **Navigation is not an edit.** It stays out of the undo stack.
7. **The watchdog observes `childList` only**, rAF-coalesced, `takeRecords()` after its own rebuild.
   `attributes` would fire on our own writes and on react-spring's 60fps rewrites.

### The harvest and the deck diverge after an edit

Not a bug in either. The harvest reads fibers, which hold what the deck was _authored_ with; an edit
writes the DOM. React never learns about it — that is exactly what makes the edit durable.

Two consequences, both handled: `get_current_slide` renders through `withEdits()` so a caller sees
its own change, and `edit_node`'s receipt prints **old → new** rather than reading the node back and
quoting the wording it just replaced.

---

## 5. Verifying

Dev server `:3000`, Chrome CDP `:9222`. Every tool is scriptable through `deckMcp.call`.

| check                                               | expected                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **navigate, then re-measure the harvest**           | still 35 slides / 162 nodes — the check that would have caught §3                     |
| `deckMcp.list()` on a normal load                   | 8 tools, no mutators, no `#deck-edit-sheet`                                           |
| same with `?mcp`                                    | 14 tools, sheet present                                                               |
| `go_to_slide` then `get_current_slide`              | the new slide — nav settles before returning                                          |
| `go_to_slide` past the end                          | clamps, and says so                                                                   |
| `move_deck` at either end                           | "already at the end", not a claimed move                                              |
| ambiguous phrase to any editing tool                | `isError` plus candidates, slide unchanged                                            |
| `slide: 0` / `99` / `-3` / `1.5` to a **read** tool | refused, naming the range — never answered from a different slide                     |
| the same values to `go_to_slide`                    | clamped, and the receipt says it clamped                                              |
| `style_node` `font-size: bigger`                    | resolved to px against the element's own size                                         |
| `style_node` `enormous` / `z-index`                 | refused by `CSS.supports` / by the allowlist                                          |
| edit, sweep all 35 slides, `reset_edits`            | **live-DOM fingerprint identical to before**, 0 stray refs, 1 empty sheet, deck alive |
| `?exportMode=true` / `?printMode=true`              | `window.deckMcp` undefined                                                            |

**Fingerprint the live DOM, not the harvest.** A harvest-based fingerprint is identical before and
after an edit — because the fibers never change — so it proves nothing about reset. That mistake
hid a broken reset through two rounds of "verification".

Then `npm run format`.

---

## 6. Next

**`chat/agent/prompt.js` is now partly wrong.** It says "You have no access to the slides, the web,
or any tools". Still true of the in-page chat model, which is not wired here — but no longer true of
the _page_. Worth a sentence so the two do not silently disagree.

**A demo option, not taken:** the code panes on slides 10–12 show an invented `search_documents`
tool. They could show the deck's _actual_ registered tools, making the code on screen the code
running the deck. That edits talk content, so it is the author's call.

**Deferred, unchanged:** items 4–7 in [deck-context-handoff.md](deck-context-handoff.md) §9. Item 4
(step awareness) is the one with a live trigger now that an agent can drive the deck.
