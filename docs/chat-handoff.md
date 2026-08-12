# Deck assistant — the model layer

The deck has a chat assistant in [`chat/`](../chat/): a robot button in the deck chrome opens a
floating window that answers questions about the talk and edits the running deck. It runs
**Gemma 4 E2B on the GPU, in the page**, via [LiteRT-LM](https://developers.google.com/edge/litert-lm/js).

This document is the record of that model layer: why it is not the Chrome Prompt API, what the
swap cost and bought, and the measured numbers to re-derive if anything changes.

> **Pre-flight, before any talk.** The model is a 2 GB download. Fetch it on a connection you
> trust and confirm the header bar reads "on disk", then open the panel and ask one question.
> See [§7](#7-pre-flight).

---

## 1. Why not the Chrome Prompt API

The assistant was built against `LanguageModel` first, and everything except the model worked.
Measured 2026-08-12 on Chrome 151.0.7922.76, and reproduced independently in a normal Chrome
profile with the Prompt API fully enabled:

| Probe                                                                                      | Result                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `LanguageModel.availability(…)`                                                            | `"downloading"` for 90+ minutes, never settling |
| Same, with **no arguments**                                                                | `"downloading"`                                 |
| Same, with `{}`, `expectedInputs` only, with/without `languages: ["en"]`, `outputLanguage` | `"downloading"` in every case                   |
| `LanguageModel.create(…)`, any config, none of our code in the stack                       | never resolves; hung past 30s repeatedly        |
| `LanguageModel.params()`                                                                   | **not a function** — absent in 151              |

Two things that ruled out: not our options (a bare no-argument call failed the same way), and
not the deck (a direct call from the page console failed identically). It was not _permanently_
broken either, which is what made it expensive to diagnose — it reported `"available"` twice and
once served a real answer.

**A postscript worth keeping.** `LanguageModel` is still _defined_ in Chrome 151, just
non-functional. After the swap, `planner.js` still held a `typeof LanguageModel === "undefined"`
guard, which therefore passed, and every single turn paid a dead 20-second `create()` before
falling back to answering. A `typeof` check is not a health check.

### What the flakiness bought

Four pieces of the design exist _because_ of failures observed there, and all four survived the
provider change — three of them because they turned out to be load-bearing for entirely
different reasons:

- **`CREATING` is a separate state from `DOWNLOADING`.** Chrome fired `downloadprogress` with
  `loaded: 0` for a model already on disk, showing "Downloading… (0%)" forever. LiteRT offers the
  mirror-image lie: a cache hit reports progress `1`, which would show a frozen **100%** through
  the whole GPU load. Hence the rule in `model-state.js`: progress belongs to the download phase
  and nothing else.
- **A ceiling on session creation.** Now scoped to the GPU load only, and the download
  deliberately has none — see [§4](#4-two-phases-and-why-the-download-has-no-deadline).
- **Re-sampling a flapping signal.** Deleted, and this one is a genuine simplification: we own
  the download now, so the state is a fact rather than a sample.
- **Abort threaded all the way down, and `stop()` not waiting for the responder.** See
  [§5](#5-the-abort-contract).

---

## 2. The shape of the model layer

```
chat/agent/providers/litert-cache.js   bytes: download, cache, verify, delete
chat/agent/providers/litert.js         wasm, GPU probe, engine, conversations, generate()
chat/agent/model-state.js              the 8-state machine
chat/agent/session.js                  streamed prose on the durable conversation
chat/agent/planner.js                  a JSON Schema -> an object, without constrained decoding
```

Everything above `model-state.js` is provider-agnostic and did not change: `plan.js`,
`schema.js`, `use-conversation.js` and the whole `chat/edit/` layer are untouched by the swap.

Two invariants in the provider are easy to destroy by tidying, and both are commented where they
live:

- **`Backend.GPU_ARTISAN` is the only usable backend.** `Backend.GPU` has no compiled executor
  and **crashes the tab** rather than erroring; `CPU_ARTISAN` is not in the web build; `CPU`
  copies the whole model into the wasm heap, which is impossible at 2 GB. GPU_ARTISAN streams
  the file section by section, which is also why the model must be a `-web` build.
- **The stream must stay an async generator over an explicit reader.** Safari has no
  `Symbol.asyncIterator` on `ReadableStream`, and `session.js` consumes with `for await`. Return
  `sendMessageStreaming(...)` directly and Chrome stays green while Safari breaks silently.

### The model

`gemma-4-E2B-it-web.litertlm`, from the ungated `litert-community/gemma-4-E2B-it-litert-lm`,
**2,008,432,640 bytes** — verified against HuggingFace's `content-length`, and used as an exact
integrity check rather than an approximate size.

Of the whole of HuggingFace, only five genuinely web-packaged `.litertlm` files exist, all Gemma
4, and this is the smallest. The `-web` packaging is load-bearing: a plain `.litertlm` fails with
`Streaming LlmExecutorMetadata section is not supported yet`. Gemma 3's LiteRT repos are
`gated: auto` and 401 without a token.

---

## 3. Running on every desktop browser

This is the part the Prompt API could never have delivered, and it is now the honest claim: the
assistant needs **WebGPU and nothing else**. No vendor API, no flag, no `SharedArrayBuffer`, and
therefore no COOP/COEP headers — which is usually what stops wasm ML from working on a static
host. WebGPU became Baseline in January 2026.

The GPU gate is deliberately small (`probe()` in `providers/litert.js`), and two plausible checks
are deliberately absent:

- **Not `maxBufferSize`.** GPU_ARTISAN streams the model, so no single buffer holds 2 GB.
  WebGPU's default limit is 256 MiB, so a gate framed as "enough for the weights" would reject
  every conformant device on earth.
- **Not `navigator.deviceMemory`.** Chromium-only, so gating on it silently rejects Safari and
  Firefox — the exact outcome this change exists to avoid.

What it does check: a secure context (a deck served from a LAN IP has no `navigator.gpu` at all,
and that is a normal way to present), an adapter, and that the adapter is not a software
fallback. `shader-f16` is recorded for the info modal rather than required, because it is the
first thing to look at if GPU_ARTISAN ever fails somewhere WebGPU is otherwise fine.

**Verified on Chrome 151 / macOS** (Apple, metal-3, `shader-f16`). **Safari 26 and Firefox are
coded for but unverified here** — see [§7](#7-pre-flight). Firefox is the bigger unknown: it is
not in the upstream LiteRT measured set at all.

### Storage, across three vendors

The 2 GB cache write is where browsers differ most, so there are two defences and an integrity
check:

- **A storage estimate before the fetch.** If it will not fit, skip the cache and stream
  straight to the engine — "works, re-downloads next time" beats "cannot run the model".
- **A `QuotaExceededError` fallback after it.** Safari reports an aspirational quota and then
  throws anyway; Firefox reports a group limit and has been seen throwing a bare `TypeError`.
  Matched on name _and_ message, because vendors disagree.
- **An exact byte-count check on write and on read.** A truncated cache entry is the nastiest
  failure available: `cache.match` returns it happily, the engine then fails on partial bytes
  with a message about wasm sections, and it looks permanent and inexplicable. A short entry is
  deleted rather than reported.
- **`navigator.storage.persist()` only from the download click.** Chrome grants it silently;
  Firefox raises a permission doorhanger, and browser chrome appearing mid-talk is worse than the
  eviction it prevents.

---

## 4. Two phases, and why the download has no deadline

`load()` separates DOWNLOADING from CREATING, and the separation is the whole design.

Under the Prompt API, a `create()` secretly waiting on a download surfaced as "the model took too
long to start" — wrong and unactionable. Worse, the outer 60s bound in `session.js` was _shorter_
than the 90s ceiling in `model-state.js`, so the inner one could never be the thing that
reported.

Now:

- **The download gets no deadline.** 2 GB on venue wifi is legitimately many minutes, and any
  fixed limit is a lie told to a presenter who is merely being patient. What replaces it is a
  **stall detector** — an idle timer that fires only when no bytes are arriving — plus a real
  cancel button, because this download is ours.
- **Only the GPU load is bounded**, and generously: measured at 3.0s cold and ~1.2s from a warm
  cache, against a 120s ceiling that exists to catch a wedge.
- **`session.js` refuses before it ever calls `load()`.** A question typed while the model is
  downloading gets told so, with byte counts. A question typed while it is merely DOWNLOADABLE is
  refused too, with the size — a keystroke is a valid user activation, but silently starting a
  2 GB fetch from typing is the rudest thing this layer could do.

`warmUp()` no longer builds an engine. Under the Prompt API the persisted flag warmed a session
that belonged to the OS; the same promotion here claims ~2 GB of GPU memory during page load,
racing Spectacle's 35-slide portal mount. Safari enforces per-tab memory limits by **killing the
tab**, so the worst case was not a slow deck but no deck, before slide 1. The engine loads in
~1.2s warm, so the first question pays almost nothing for the change.

---

## 5. The abort contract

Aborting has to work in three places, and the same trap exists for LiteRT as for Chrome:

1. **Inside the router.** `plan.js` passes `signal` into `decode()`, which races every call
   against both a timeout and the signal.
2. **Inside a load that never settles.**
3. **Mid-stream**, with a partial answer to keep.

Two halves of the fix, both still required:

- **Thread `signal` everywhere.** LiteRT has **no `AbortSignal` support anywhere in its API**;
  `conversation.cancel()` is the only mechanism, so a signal that does not reach that call does
  nothing at all — generation continues, burning the GPU, until it finishes on its own.
- **`stop()` does not wait for the responder.** [`use-conversation.js`](../chat/use-conversation.js)
  bumps a run token, records the partial, and clears `busy` immediately.

### `cancel()` poisons the conversation — and how that is survived

The single most surprising measured fact in this layer:

> **One `conversation.cancel()`, from any cause, permanently kills that conversation.** Every
> later `sendMessageStreaming` on it rejects with `Error: Task cancelled`. It does not recover
> with time. **`clone()` inherits the poison _and_ loses the history** — a clone of a cancelled
> conversation reports 0 tokens.

If that reads familiar, it is nearly the Chrome 151 bug this file used to document in its
constrained-decoding section: a second `responseConstraint` prompt failing with `kErrorUnknown`,
with `clone()` tainted too. Different API, same shape.

Untreated, that makes the stop button a one-shot: press it once and the assistant is mute for the
rest of the talk. What saves it is that a cancelled conversation is still **readable** —
`getHistory()` and `getTokenCount()` both work. So the provider replaces a poisoned conversation
with a fresh one carrying its history forward as the preface. Verified: a replacement still
recalls a fact established before the cancel, where a control conversation with no history does
not. It costs ~2ms, and the healing is deferred to the next turn, inside the generation lock, so
it cannot race the generation still unwinding.

### One generation at a time

There is a lock around every generation, and it has no counterpart upstream. Because `stop()`
deliberately does not wait, a second `sendMessageStreaming` can be issued while the previous
stream is still cancelling — and the engine has one main executor, shared with the router's
throwaway conversations. Teardown is bounded, because a lock nobody releases is worse than the
overlap it prevents.

---

## 6. Constrained decoding: what replaced it

The edit pipeline was built on `responseConstraint`. Its value was not politeness: `schema.js`
splices the live element refs, style properties, class names and var names into the schema as
`enum`s **per turn**, so a hallucinated reference was not rejected after the fact — it was
_undecodable_.

**LiteRT-LM has no equivalent.** Verified against the 0.15.0 type declarations rather than
guessed: `SessionConfig` offers `samplerParams {type, k, p, temperature, seed}`, `stopTokenIds`,
`numOutputCandidates`, `samplerBackend` and `maxOutputTokens`, and that is all — no grammar, no
JSON schema, no response format, no logit bias. (There is a prompt-level `AutoToolChat` under
`@litert-lm/core/orchestration`, but it is unconstrained, so it buys nothing here.)

So [`planner.js`](../chat/agent/planner.js) does **prompt-and-validate**: render the schema into
the prompt, generate at `temperature: 0`, extract the first brace-balanced object, validate,
snap near misses, repair once. It remains the only module that knows how a schema becomes an
object.

The principle throughout: **a value that does not validate is dropped, never coerced into
something plausible.** `chat/edit/apply.js` re-validates every op independently and resolves
every ref against the live DOM, so a dropped field becomes a readable refusal rather than a wrong
edit. That safety net predates this change and is exactly why prompt-and-validate is survivable.

### What the validator must do, because `apply.js` does not

Two of these were **latent bugs** that constrained decoding had been masking:

- **Type coercion.** `apply.js` passes values straight through, so `on: "false"` is a truthy
  string and `toggle_class` would _add_ the class the user asked to remove. Never `Boolean(value)`.
- **`additionalProperties: false`.** `plan.js` does `apply({ op, ...filled })`, spreading
  `filled` **last** — so a reply containing `"op": "reset"` would override the routed op and wipe
  every edit. Stripping to declared keys is the fix, not tidiness.
- **`maxLength`**, rejected rather than truncated: a mid-word cut landing on a live slide is worse
  than a refusal. The 140-character cap is a layout guard for a fixed 1366×768 canvas.
- **Range clamping**, applied _before_ `apply.js` sees the value, because receipts are generated
  from what was applied — clamping afterwards would print "→ slide 47" for a 35-slide deck.

### Snapping, and where it is refused

Every rung of the ladder requires a **unique** winner, which is what makes it safe rather than
clever: `text-align`/`text-transform`/`text-decoration` all contain `text-`, so a bare `text-`
must fail rather than pick the first; `background-color` contains `color`, so `color` must win by
exact match and never by substring. Distance is capped at 1, because at 2 genuinely distinct
values merge.

**Refs are never snapped.** They are opaque generated ids (`e1`, `e2`, …), so every distance-1
neighbour of a ref is _another real element_ — snapping `e3` to `e8` would edit the wrong thing
on a live slide and read to the audience as a deck bug. Every snap is logged.

### The router does not ask for JSON

`ROUTE_SCHEMA` is a single enum, so asking a 2B model for `{"op":"set_text"}` spends tokens on
syntax it can get wrong. It asks for one bare word with an 8-token cap and matches it. Zero or
ambiguous matches default to `answer`, which is the documented safe fallback and cannot damage
the deck — one generation, not a repair round.

### What prompting cannot fix, and what it must

A grammar would never have caught the failure actually observed: "Go to slide 12" decoding as
`where: "prevSlide"`, a perfectly valid enum member and the wrong answer. Only the prompt can, so
`plan.js` now carries a one-line hint per op. That is the real shape of this trade — losing
constrained decoding costs prompt work, not just validation.

---

## 7. Pre-flight

Do this before a talk, on the machine you will present from:

1. **Download the model** from the state icon in the panel's header bar, on a connection you trust. ~46s on a fast
   link; assume much longer on venue wifi.
2. **Confirm "on disk"** on that icon, and open the info modal to check the GPU row.
3. **Ask one question**, and press stop mid-answer once.
4. **If you are presenting from something other than Chrome**, do all of the above there. Safari
   26 and Firefox 145+ are coded for and unverified. If GPU_ARTISAN does not run on Firefox, that
   is the thing you want to discover now.
5. **Consider the wasm.** It is ~20 MB from jsDelivr, fetched when the engine is built, so a
   blocked or throttled CDN means a cached model that still cannot run. A cold run at the venue
   is the only way to know.

---

## 8. Measured numbers

Chrome 151, macOS, Apple GPU (metal-3, `shader-f16`), `maxNumTokens: 8192`.

| Quantity                              | Value                              |
| ------------------------------------- | ---------------------------------- |
| Model download (fast link)            | 46.2s for 2,008 MB                 |
| Engine create, cold                   | 3.0s                               |
| Engine create, warm cache             | ~1.2s                              |
| New conversation (even with history)  | ~2ms — the preface prefills lazily |
| Restart (the broom)                   | ~2ms, context back to 0            |
| Reload after trash (engine stays hot) | ~4ms                               |
| Time to first token                   | 74–330ms                           |
| Prefill                               | ~1,900–2,000 tokens/sec            |
| Decode                                | ~70 tokens/sec                     |
| A full answer turn                    | ~0.9–1.2s                          |
| Router decode                         | ~120–150ms                         |
| Fill decode                           | ~280–600ms                         |
| `busy` cleared after pressing stop    | 11ms                               |
| System prompt                         | ~660 tokens                        |
| Per-turn retrieval + question         | ~330 tokens                        |
| First turn's prefill                  | ~840 of 8,192 tokens (~14%)        |
| Turns before the context meter warns  | ~20                                |

### The context window, and why 8,192

Four "limits" are in play and they disagree:

| Source                                                           | Says   | Enforced?                |
| ---------------------------------------------------------------- | ------ | ------------------------ |
| Architecture (`google/gemma-4-E2B-it` `max_position_embeddings`) | 128k   | yes, by the model        |
| `litert-community` model card, in prose                          | 32k    | **no**                   |
| The `.litertlm` file's `LlmMetadata.max_num_tokens`              | absent | nothing to enforce       |
| LiteRT-LM's own default when unset                               | 4,096  | only if you pass nothing |

The file declaring nothing is the load-bearing part: there is no cap to hit and no way to query
one — [LiteRT-LM #2865](https://github.com/google-ai-edge/LiteRT-LM/issues/2865) is open precisely
because a package's real capacity is not exposed. Whatever we pass is what we get, confirmed by
reading `engine.settings.mainExecutorSettings.maxNumTokens` back at runtime.

So the number came from measurement, with a deck-realistic prompt (~840 tokens of preface plus a
question) on an Apple GPU:

| `maxNumTokens` | create | avg ttft | prefill  | decode |
| -------------- | ------ | -------- | -------- | ------ |
| 4,096          | 1154ms | 88ms     | 1577 tps | 72 tps |
| **8,192**      | 1017ms | 86ms     | 1608 tps | 71 tps |
| 16,384         | 1016ms | 83ms     | 1630 tps | 70 tps |
| 32,768         | 1000ms | 93ms     | 1438 tps | 66 tps |
| 65,536         | 1002ms | 108ms    | 1167 tps | 60 tps |
| 131,072        | 1033ms | 865ms    | 37 tps   | 59 tps |

**Every value loads, 128k included, and engine creation is flat** — the KV cache is cheap for this
model because it is multi-query (one KV head) and shares KV across 20 of its 35 layers, leaving
only three unshared global layers to scale with the window. The cost is **decode throughput**,
which is the number a presenter actually feels, not the GPU memory you would expect.

#### It also changes the answers, which is worth knowing before tuning it

At `temperature: 0` the same prompt should give the same answer whatever was allocated. It does
not. Measured with two independent runs at 4,096 as a drift control:

- The two 4,096 runs agreed with each other **6/6**, so the method is sound and differences are
  real rather than run-to-run noise.
- **8,192 and 16,384 are byte-identical** — same answers, same token counts, same totals. There is
  nothing to choose between them.
- 4,096 differs from both, consistently. Across 13 questions on a fresh conversation each, 12
  answers differed — but as _paraphrases_, with near-identical total output (2365 vs 2368 chars)
  and correct refusals for off-deck questions on both. Neither is better.

So there is a threshold somewhere between 4k and 8k where the numerics shift the greedy-decode
path, and above 8k it stops mattering. **Conversation depth does not matter either**: the same
question at turns 1, 7, 12, 17 and 22 returns a byte-identical answer, matching a fresh
conversation, so history piling up does not degrade anything.

8,192 is the choice, and NOT for per-turn quality — it is identical to anything larger. It is that
a window the conversation can actually fill keeps the context underline meaningful. At 16k the
meter reads ~5% all night and the broom never looks necessary; at 8k a first turn shows ~14% and
the gauge means something. Do not raise it to buy headroom.

Drop it to 4,096 if a device OOMs during load. If you do change it, watch decode throughput rather
than load time, and re-run the drift control before believing any quality difference you think you
see.

**Note that `getTokenCount()` reads 0 on a fresh conversation.** The preface prefills lazily, so
0 is honest — nothing has been spent yet.

---

## 9. Verified

Chrome 151 over CDP, against the dev server. Test drivers live in the session scratchpad, not the
repo. **Kill any backgrounded driver before running another** — one left running polluted several
measurements by typing into the same tab.

**The model layer.** Cold download with byte-accurate progress; integrity check accepting a good
entry; engine create; multi-turn history; abort mid-stream keeping its partial; **abort then
immediately asking again**, twice in a row; two streams launched with no await between them
serialising rather than colliding; restart forgetting history and staying usable, twice; delete
and re-download.

**The chat path, through the real panel.** Deck-aware answers ("This talk is about the frontend
striking back with WebMCP and the agent-ready browser…"); the context meter moving 0 → 993 →
1,277; stop keeping its partial and flagging it `stopped` with the composer usable in 11ms and
nothing leaking in late; the broom; the trash leaving the engine hot; the info modal's rows.

**The edit path, live.** `goto` → `→ slide 12`; `set_style` → `font-size e1 → 36px`; `set_var` →
`--chapter-accent → orange (chapter)`; undo stepping the patch log back; reset emptying it.

**The edit path, adversarially — 34/34.** Deterministic cases through the exported
`parseInto(raw, schema)`, so a failure is a real defect rather than a bad day for a 2B model:
`on: "false"`/`0`/`"off"` → `false` and `"maybe"` dropped; `slideIndex "7"` → `7`, `47` clamped to
35, `0` clamped to 1, `"abc"` dropped; a 300-character `set_text` dropped and reported while 140
is kept; an injected `"op": "reset"` and every undeclared key stripped; a hallucinated `e9` and a
near-miss `e4` both refused rather than snapped; `font_size` and `Font Size` → `font-size`;
`color` beating `background-color`; ambiguous `text-` dropped; a CSS var accepted without its
dashes; a fenced reply with a preamble and a trailing sentence parsed; braces inside a string
value handled; missing required fields named.

**The deck, unharmed.** All 35 slides swept both directions with the panel open: zero console
errors, the robot never moving (one `x` for all 35 slides, title slide included), exactly one chat root and one panel, no
stray patch stylesheet. `padding-bottom` reservation intact — one `slide--full` at 0px, 34 others
at 122px. Export and print mode mount no chat: 35 toggle _elements_ exist because `Template`
renders one per slide and export renders every slide, but **zero are visible and zero have a
layout box** (`chat.css` hides them in paged mode as belt-and-braces for printing the live deck,
which never runs `mountChat()`'s own bail-out). Presenter mode keeps its bridge. `/styles`
untouched. Zero real console errors in every mode.

### Known-good, known-unverified

- **Answer quality is a 2B model's.** Most answers are good and grounded; some are weak, and it
  occasionally declines a question the deck does answer. The plumbing is not the limit here.
- **A stale-ref refusal is reachable by firing instructions faster than a human can.** Spectacle
  navigates via a React state update, so an instruction issued within ~700ms of a `goto` builds
  its inventory against the old slide and applies against the new one. `apply.js` refuses safely
  and readably, which is the designed outcome.
- **Safari and Firefox are unverified.** See [§7](#7-pre-flight).

---

## 10. A bug found on the way

`chat/deck-adapter.js` did `!!deckNav.advanceSlide()`, but **Spectacle's relative-navigation
functions return `undefined`**. So `nav.nextSlide()` always reported failure, `apply.js`'s
`if (!moved)` turned it into "I couldn't move the deck.", and the deck advanced while the receipt
said it had not. `toSlide` never had the bug because it returns `true` explicitly after `skipTo`.

Pre-existing and unrelated to the provider swap, but it was making a delivered path lie, so it is
fixed. Reporting success is the honest answer rather than a convenient one: Spectacle clamps at
both ends, so a call at the last slide is a no-op and not a failure — and there is nothing to
detect anyway, because the move lands via a state update rather than synchronously.

---

## 11. Architecture, in one screen

```
index.html  ──┬── root  →  Deck  →  Template  →  <DeckBridge/>  ──┐
              │                              └─ <ChatToggle/>     │ publish
              └── chat-root  →  Panel (own createRoot on body) ←───┘ subscribe
```

- **Two React roots.** The panel mounts on `<body>`, outside the deck, because Spectacle's slide
  portal carries a `transform: scale()` and `overflow: hidden`, `TemplateWrapper` is
  `pointer-events: none`, and presenter/overview mode remounts everything inside it.
- **`DeckBridge` is the only hook-using code in the deck tree.** Spectacle calls `template` as a
  _plain function_ during `Deck`'s own render, so hooks written directly in `Template` borrow
  Deck's hook list — which is why `Template` can no longer early-return. The bridge is safe only
  as an _element_, and only if it renders on every slide.
- **First bridge wins.** Overview mode renders the template once per slide — 35 `DeckBridge`
  instances. Ownership is claimed by the first to mount.
- **Closing the panel hides it, never unmounts it.** That is the whole disable-without-losing-state
  mechanism.
- **`chat/deck-adapter.js` is the only deck-aware module.** Roles, skip regions, allowlists, the
  chapter table, navigation. Porting to another deck should mean rewriting that one file.
- **Three integration touchpoints**, and they must be removed together: the stylesheet link in
  `<head>`, the caught dynamic `mountChat()` after `root.render(...)`, and the `DeckBridge` /
  `ChatToggle` elements in `Template`.

### Durability model (unchanged by the provider swap)

React diffs its own previous props against next props, never against the DOM, so an imperative
mutation survives every re-render where React's own value is unchanged. Three tiers:

1. **CSS only**, in a chat-owned `<style>` regenerated wholesale from the patch log, every
   declaration `!important` — beats react-spring's per-frame inline writes, and beats
   `applyChapterStyles()` on document order.
2. **`nodeValue` and `classList` only.** **Never `textContent`** — it removes nodes React's fiber
   still references, and the next commit touching that subtree can throw `NotFoundError` from
   `removeChild` and unmount the root. A blank deck, mid-talk. `chat/edit/apply.js` is the only
   writer and enforces this.
3. **Patch log + replay.** `rebuild()` = restore baselines, regenerate the sheet, replay in order.
   Undo rebuilds from the log rather than applying inverses, so apply/undo/redo/reset and
   remount-recovery are one code path.
