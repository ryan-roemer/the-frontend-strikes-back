# Deck assistant — handoff

The deck has a chat assistant in [`chat/`](../chat/): a robot button in the deck chrome opens a
floating window that answers questions about the talk and edits the running deck. Everything works
**except the model**. The Chrome Prompt API does not currently function on this machine, and the
next step is to swap the provider for LiteRT.js + Gemma 4.

This document is for that spike. It covers what the Prompt API does wrong, where the seam is, and
what Joyce's LiteRT provider already knows that you should not rediscover.

---

## 1. Why the Prompt API is being replaced

Measured 2026-08-12 on Chrome 151.0.7922.76, and reproduced independently in a normal Chrome
profile with the Prompt API fully enabled:

| Probe                                                                                      | Result                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `LanguageModel.availability(…)`                                                            | `"downloading"` for 90+ minutes, never settling |
| Same, with **no arguments**                                                                | `"downloading"`                                 |
| Same, with `{}`, `expectedInputs` only, with/without `languages: ["en"]`, `outputLanguage` | `"downloading"` in every case                   |
| `LanguageModel.create(…)`, any config, none of our code in the stack                       | never resolves; hung past 30s repeatedly        |
| `LanguageModel.params()`                                                                   | **not a function** — absent in 151              |

Two things this rules out: it is not our `PROMPT_OPTIONS` (a bare no-argument call fails the same
way), and it is not the deck (a direct call from the page console fails identically).

It is not _permanently_ broken either, which is what made it expensive to diagnose. It reported
`"available"` twice, and early on served one genuine answer — _"A browser is a software application
that allows you to access and view websites on the internet."_ So the plumbing in `chat/agent/` is
known to work end to end; the platform is what is unreliable.

`chrome://on-device-internals` would say more, but it is gated behind the debug-WebUI toggle at
`chrome://chrome-urls`.

Every `TODO(PROMPT)` in the tree points back to this section. They are in
[`chat/agent/model-state.js`](../chat/agent/model-state.js),
[`chat/agent/session.js`](../chat/agent/session.js), and
[`chat/agent/planner.js`](../chat/agent/planner.js).

### What the flakiness bought

Four pieces of the design exist _because_ of failures observed here, and they are worth keeping
whatever the provider:

- **`CREATING` is a separate state from `DOWNLOADING`.** Chrome fires `downloadprogress` with
  `loaded: 0` even for a model fully on disk, so trusting the event alone showed
  "Downloading… (0%)" while `availability()` said `available`.
- **A ceiling on `create()` (90s).** Without it a hung create left `pendingLoad` set forever,
  `refresh()` early-returned on "a load is in flight", and the machine wedged permanently. It now
  times out and re-reads availability. Verified: recovers to a clickable `on-disk`.
- **Re-sampling a flapping signal.** One sample at mount is a fact about an instant, not the model.
- **Abort threaded all the way down.** See §4.

---

## 2. The seam you are replacing

Only **two files** talk to `LanguageModel`. Everything else is provider-agnostic.

```
chat/agent/model-state.js   lifecycle: availability, create, destroy, progress, context usage
chat/agent/planner.js       constrained decoding on throwaway sessions
```

Their consumers depend on exactly this much:

| Consumer                  | Needs                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chat/agent/session.js`   | `getSession()`, `isReady()`, `load()`, `refresh()`, `getState()`, `touch()`, and a session exposing `promptStreaming(text, { signal })` |
| `chat/agent/plan.js`      | `decode({ system, message, schema, label, signal }) → object`                                                                           |
| `chat/ui/model-status.js` | `STATES`, `STATE_META`, `getState()`, `subscribe()`, `load()`, `unload()`, `refresh()`, `contextInfo()`, `modelInfo()`                  |

So a LiteRT provider needs to satisfy: **an 8-state machine, a streaming session, and constrained
decoding.** The first two map cleanly. The third does not — see §5, it is the real design question.

### Suggested shape

Rather than editing `model-state.js` in place, add a provider layer under it, the way Joyce does
(`llm.js` routes to `providers/{chrome,web-llm,litert}.js` behind one contract). Joyce's contract is
already close to what this deck needs:

```js
getCapabilities() → { supportsMultiTurn, supportsTokenTracking, usesMessageArray }
createHandler({ model, systemContext, temperature, maxTokens }) → { sendMessage(input), destroy() }
```

where `sendMessage` is an async generator yielding `{ type: "data", content }` then
`{ type: "done", finishReason, usage }`. `chat/agent/session.js` already consumes an accumulated-text
stream, so adapting is a small loop.

---

## 3. What Joyce already knows

Joyce's `experiment/litert` branch has a working provider. Read these before writing anything:

| File                                              | Why                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `public/local/data/api/providers/litert.js`       | The provider. Engine creation, streaming, OOM detection, token counting |
| `public/local/data/api/providers/litert-cache.js` | HuggingFace download + Cache API storage, `isCached`, `deleteCached`    |
| `public/shared-config.js:165-215`                 | Pinned wasm URL, the model tiers, and the hard-won notes below          |
| `public/index.html:58-75`                         | Import map entry and the Link-header 404 gotcha                         |

### Findings to inherit rather than repeat

- **Only five genuine web-optimized `.litertlm` files exist on all of HuggingFace**, all Gemma 4,
  and the smallest is 2 GB. Joyce ships two: `gemma-4-E2B-it-web` (2,008 MB) and
  `gemma-4-E4B-it-web` (2,969 MB), both from ungated `litert-community/…` repos.
- **The `-web` packaging is load-bearing, not cosmetic.** The `GPU_ARTISAN` backend streams the file
  section by section; plain `.litertlm` builds fail outright with
  `Streaming LlmExecutorMetadata section is not supported yet`.
- **Gemma 3 LiteRT repos are `gated: auto`** and 401 without a token — unusable.
- **Small CPU-backend models are a dead end.** Qwen3-0.6B int4 loads in 15.5s, but prefill runs at
  4–8 tok/s, which turns a few thousand tokens of context into minutes before the first token.
- **`maxTokens: 8192` is a KV-cache budget, not a model ceiling** (Gemma 4 does 32k). Bigger costs
  GPU memory on top of ~1.8 GB of weights. Drop to 4096 if a device OOMs on load.
- **Pin the wasm and the package together.** `LITERT_WASM_URL` must match the `@litert-lm/core`
  version in the import map (`0.15.0`).
- **Safari has no async iteration on `ReadableStream`** — Joyce uses an explicit `getReader()` loop
  and cancels both conversation and reader if the generator is abandoned mid-answer.
- **A WebGPU OOM is a thrown error, not an event.** Joyce regex-matches
  `/out of memory|\boom\b|rangeerror|allocation failed|device.*lost/i`.

### Cost to this deck

This is the thing to weigh first. The deck's entire dependency story is _"the import map is the
lockfile"_ (see [dependencies.md](dependencies.md)) and it currently ships **zero** new dependencies
for the assistant. LiteRT means one CDN entry, a separately-pinned wasm directory, and a **2 GB
model download** on the presenting machine. For a conference talk that is a real pre-flight step,
not a detail — and the talk's own thesis is about what the browser can do without a server, so a
2 GB first-run cost is worth being deliberate about.

---

## 4. The abort contract (do not lose this)

The stop button was broken in a way worth understanding before you touch the provider, because the
same trap is there for LiteRT.

Aborting has to work in three places, and originally only the third did:

1. **Inside the router's `create()`/`prompt()`.** `plan.js` was not passing `signal` into
   `decode()`, so stop did nothing while the router was thinking — the turn ran to completion and
   only then noticed.
2. **Inside a `create()` that never settles.** This is the platform failure. Aborting a signal
   nobody is listening to leaves `busy` true forever.
3. **Mid-stream**, with a partial answer to keep.

The fix has two halves, and a new provider must preserve both:

- **Thread `signal` everywhere.** `planner.js` races every call against both a timeout _and_ the
  signal, hands `signal` to Chrome so generation is actually cancelled, and destroys a session that
  arrives after an abort. `plan.js` passes `signal` to both decode passes and rethrows `AbortError`
  instead of falling back to answering.
- **`stop()` does not wait for the responder.** [`chat/use-conversation.js`](../chat/use-conversation.js)
  bumps a **run token**, records the partial, and clears `busy` immediately. Any late result from the
  abandoned turn sees a stale token and is discarded. This is what makes stop work against a
  responder that never settles — and with LiteRT you will have the same need, because a WebGPU
  generation is not always promptly cancellable.

Verified for both cases: `busy` clears, the partial is kept and marked `stopped`, the composer is
immediately reusable, and nothing leaks in later.

---

## 5. The open design question: constrained decoding

This is the one thing that does **not** port, and it decides how much work the spike is.

The edit pipeline is built on the Prompt API's `responseConstraint`. Its value is not politeness —
element refs, style properties, class names and var names are spliced into the schema as `enum`s
**per turn**, so a hallucinated reference is not merely rejected, it is _undecodable_. On a 3B model
that is worth more than any prompt wording, and it is what makes it safe to let a small model edit a
live deck. See [`chat/agent/schema.js`](../chat/agent/schema.js).

**LiteRT-LM has no equivalent.** Joyce never needed one (grep its LLM layer: no
`responseConstraint`, no `json_schema`, no tool calling). So you must pick:

1. **Prompt-and-validate.** Ask for JSON, parse, validate against the same allowlists
   `chat/edit/apply.js` already enforces, and repair once on failure. Cheapest. The safety net
   already exists — `apply.js` re-validates every op regardless of the schema, precisely so a
   mismatch is a refusal rather than a broken slide. Expect a materially worse hit rate on refs.
2. **Grammar-constrained sampling, if LiteRT exposes it.** Check whether `@litert-lm/core` supports
   a logit processor or GBNF-style grammar. If it does, this is the faithful port.
3. **Keep two providers.** Prompt API for constrained op decoding _when it works_, LiteRT for prose.
   Honest but doubles the surface, and rests on the API being reliable, which is the thing in doubt.

Recommendation: start with (1), and keep [`chat/agent/planner.js`](../chat/agent/planner.js) as the
only place that knows how a schema becomes an object. Its whole public surface is one function —
`decode({ system, message, schema, label, signal })` — so swapping strategies later is contained.

Note also why planner sessions are ephemeral: in Chrome 151 a _second_ `responseConstraint` prompt
on a session that already served one rejects with `kErrorUnknown`, `clone()` inherits the taint, and
`append()` does not help (documented in `web-agents/public/app/agents/prompt-api.js:198-224`). That
constraint is Chrome-specific and a LiteRT provider is free to reuse one conversation.

---

## 6. What is already verified, and stays verified

None of this depends on the model, so it should not need re-testing after the swap:

- **The deck is unharmed.** 35-slide sweep both directions, zero console errors, the robot never
  moving (`x: 43` on every slide), exactly one `DeckBridge` throughout. `--chrome-h` reservation
  intact: one `slide--full` at 0px, 34 others at 122px. Export/print mode mounts no chat at all.
  `/styles` untouched.
- **The edit layer**, driven by hand-built ops with no model: text edits surviving navigation, the
  chapter-accent override beating `applyChapterStyles()`, three-deep undo restoring exact
  originals, reset emptying the sheet, and the dangerous mixed-content case keeping its inline `<i>`
  icon (`iconsBefore: 1, iconsAfter: 1`).
- **The full route→fill→apply pipeline**, with `LanguageModel` stubbed: every op, refusals for
  unknown refs and disallowed properties, and a fill-pass failure reported rather than swallowed.
- **Deck knowledge**: 35 slides harvested, 27 carrying a chapter, retrieval picking sensible slides.

Test scripts live in the session scratchpad, not the repo. They drive Chrome over CDP on `:9222`
against the dev server on `:3000`. **Kill any backgrounded test driver before running another** —
one left running polluted several measurements by typing into the same tab.

### Numbers worth keeping

| Quantity                                      | Value                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Prompt API real input window                  | **9,216 tokens** — not the nominal 32k. Matches Joyce's "~9K" note |
| System prompt (deck facts + 35-slide outline) | ~660 tokens                                                        |
| Per-turn retrieval + question                 | ~160 tokens                                                        |
| Session creation, warm                        | ~9.5s                                                              |
| Longest harvested slide                       | 310 chars (cap is 600 — nothing truncates)                         |

The token budget is the number to re-derive first for Gemma 4: at `maxTokens: 8192` the arithmetic
is similar, so the ~660-token system prompt should still fit comfortably.

---

## 7. Architecture, in one screen

```
index.html  ──┬── root  →  Deck  →  Template  →  <DeckBridge/>  ──┐
              │                              └─ <ChatToggle/>     │ publish
              └── chat-root  →  Panel (own createRoot on body) ←───┘ subscribe
```

- **Two React roots.** The panel mounts on `<body>`, outside the deck, because Spectacle's slide
  portal carries a `transform: scale()` and `overflow: hidden`, `TemplateWrapper` is
  `pointer-events: none`, and presenter/overview mode remounts everything inside it.
- **`DeckBridge` is the only hook-using code in the deck tree.** Spectacle calls `template` as a
  _plain function_ during `Deck`'s own render, so hooks written directly in `Template` borrow Deck's
  hook list — which is why `Template` can no longer early-return. The bridge is safe only as an
  _element_, and only if it renders on every slide.
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
