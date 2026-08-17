# Deck assistant — the model layer

The deck has a chat assistant in [`chat/`](../chat/): a sparkle button in the deck chrome opens a
floating window that answers questions. It runs an on-device model through **either of two
providers**, switchable live from the panel header:

| Provider   | Runtime                                                                            | Model                   |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------- |
| **Gemma**  | [LiteRT-LM](https://developers.google.com/edge/litert-lm/js) on WebGPU             | Gemma 4 E2B, 2 GB, ours |
| **Chrome** | The [Prompt API](https://developer.chrome.com/docs/ai/prompt-api), `LanguageModel` | Gemini Nano, Chrome's   |

This document records that model layer: the interface the two providers share, where the
abstraction genuinely leaks, and the measured numbers to re-derive if anything changes.

> **Pre-flight, before any talk.** The Gemma model is a 2 GB download. Fetch it on a connection
> you trust and confirm the header bar reads "on disk", then ask one question on **both**
> providers. See [§7](#7-pre-flight).

**Scope note.** An earlier build of this assistant also read the deck as context (DOM
harvesting, IDF retrieval, per-turn excerpts) and edited the running deck (a router, a JSON fill
pass, a patch log). Both were removed to make room for the two-provider work; the chat is now
deliberately deck-unaware. The read-only deck bridge (`bus.js`, `bridge.js`, `use-deck.js`) is
still wired and still unconsumed, because it is the seam those features come back through.

> **Since then:** deck reading is back, in [`chat/harvest/`](../chat/harvest/) — a fiber-tree walk
> that emits the whole deck as Markdown, including speaker notes the DOM harvest could not see —
> **and it is now wired to the model.** The assistant knows the deck's outline and argument, and
> the full text of any slide a question has been asked from. See
> [§6a](#6a-what-the-model-knows-about-the-deck), and
> [deck-context-handoff.md](deck-context-handoff.md) for the extraction underneath it.

---

## 1. The two providers, and where the abstraction leaks

Everything above `providers/` is provider-shaped and does not care where tokens come from. That
is not the interesting part. **Where the two disagree is the actual story about on-device AI in
a browser today**, and the panel is built so that flipping the switcher changes nothing except
those things:

|                     | Gemma (LiteRT)             | Chrome (Prompt API)                 |
| ------------------- | -------------------------- | ----------------------------------- |
| who owns the bytes  | the page                   | the browser                         |
| download progress   | real, in bytes             | a fraction, if it reports at all    |
| cancel a download   | yes, it is our `fetch`     | no                                  |
| delete the model    | yes, it is our Cache entry | no — `chrome://on-device-internals` |
| status is a fact    | yes                        | **no**, `availability()` flaps      |
| requires WebGPU     | yes, non-fallback adapter  | not our problem                     |
| context readout     | async sample, cached       | synchronous, exact                  |
| a throwaway session | ~2ms                       | a full `create()`                   |
| runs on             | every desktop browser      | Chrome only                         |

### The interface

Each provider module exports one `provider` object; the contract is documented in full at the
top of [`providers/index.js`](../chat/agent/providers/index.js). In outline:

```
id · label · capabilities · timings · stateMeta
offered()   probe()   status()
acquire({system, signal, onPhase}) -> Chat
release()   evict()   remove()   resident()
info()      unavailableCopy(status)
```

and the **Chat handle** `acquire()` resolves to:

```
stream(text, {signal})   async generator over DELTAS
context()                SYNC {used, total, pct} | null
sampleContext()          Promise, may be a no-op
restart()   destroy()   benchmark()
```

Four capability flags carry real weight rather than being descriptive:

- **`authoritativeStatus`** — false on Chrome. `session.js` re-samples before refusing a
  question when this is false. Without it, Chrome's flapping `availability()` rejects every
  question for minutes after the model became usable.
- **`ownsBytes`** — decides whether `DOWNLOADING` gets a cancel button or a re-check.
- **`canDelete`** — gates the info modal's delete button against `manageNote`.
- **`cheapRestart`** — false on Chrome, so the broom shows `CREATING` instead of pretending to
  be instant.

### Where the eight states strain

The state set fits both, with three seams worth knowing (also commented in
[`states.js`](../chat/agent/states.js)):

- **`DOWNLOADING` is two states wearing one name.** Ours is a fact with a cancel button;
  Chrome's is a report whose only action is to look again.
- **`CREATING`'s ceiling means opposite things.** 120s on LiteRT is a wedge detector on a phase
  measured at 1–3s. 90s on Chrome is a bail-out on a phase that can legitimately take minutes,
  because `create()` secretly blocks on a download. Same field, two reasons, both commented at
  their definitions in `timings`.
- **`UNSUPPORTED` is unreachable for Chrome** under the "only offer it when the global exists"
  rule. Kept as a defensive fallback: the global can exist and `availability()` still throw.

### Provider selection

Prefers the last **explicit** choice (`localStorage["chat:provider"]`), then Chrome, then
Gemma. Preferring Chrome looks reckless given [§2](#2-the-chrome-prompt-api-as-measured), and
would be if selecting a provider loaded it — it does not. The mount-time `refresh()` stops at
`ON_DISK`, so the choice costs one `availability()` call on page load. The key is written only on an explicit
switch, never on the fallback path, and a stale id falls back rather than throwing.

---

## 2. The Chrome Prompt API, as measured

The assistant was built against `LanguageModel` first and everything except the model worked.
Measured 2026-08-12 on Chrome 151.0.7922.76, reproduced independently in a normal profile:

| Probe                                                                | Result                                          |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| `LanguageModel.availability(…)`                                      | `"downloading"` for 90+ minutes, never settling |
| Same, with no arguments / `{}` / every option combination tried      | `"downloading"` in every case                   |
| `LanguageModel.create(…)`, any config, none of our code in the stack | never resolves; hung past 30s repeatedly        |
| `LanguageModel.params()`                                             | **not a function** — absent in 151              |

Not our options (a bare no-argument call failed the same way) and not the deck (a direct console
call failed identically). It was not _permanently_ broken either, which is what made it
expensive to diagnose — it reported `"available"` twice and once served a real answer.

**Re-measured 2026-08-13 on the same machine and browser, it works.** `availability()` returns
`"available"`, `create()` resolves in 140ms–8.5s, and multi-turn answers are correct. Nothing
changed on our side. That is the honest state of this API: it is not reliably broken, which is
worse than being reliably broken, and every defensive mechanism in
[`providers/chrome.js`](../chat/agent/providers/chrome.js) stays for that reason.

**A postscript worth keeping.** `LanguageModel` was still _defined_ while non-functional. A
`typeof LanguageModel === "undefined"` guard therefore passed, and every turn paid a dead
20-second `create()`. **A `typeof` check is not a health check** — which is why `offered()`
gates the switcher and `status()` gates everything else.

### Two API details that cost real time

- **`contextUsage` / `contextWindow`, not `inputUsage` / `inputQuota`.** The spec renamed these
  and most published documentation still uses the old pair. Reading only the documented names
  returned `undefined`, which silently hid the context meter and looked exactly like a provider
  with nothing to report. `context()` checks both. Measured: 9 / 9,216 on a fresh session,
  24 after one turn.
- **`PROMPT_OPTIONS` must be passed to both `availability()` and `create()`.** Availability is
  per-configuration; asking about one and creating another can report available and then fail.
- **The `canDownload` arbiter.** Chrome fires `downloadprogress` with `loaded: 0` for a model
  already on disk. Trusting the event alone pinned "Downloading… (0%)" forever, so the
  pre-create `availability()` decides what the event means.

---

## 3. Running on every desktop browser

This is what the Prompt API could never deliver and is the honest claim for the Gemma provider:
it needs **WebGPU and nothing else**. No vendor API, no flag, no `SharedArrayBuffer`, and
therefore no COOP/COEP headers — usually what stops wasm ML working on a static host. WebGPU
became Baseline in January 2026.

The GPU gate (`probe()` in `providers/litert.js`) is deliberately small, and two plausible
checks are deliberately absent:

- **Not `maxBufferSize`.** GPU_ARTISAN streams the model, so no single buffer holds 2 GB.
  WebGPU's default limit is 256 MiB, so a gate framed as "enough for the weights" would reject
  every conformant device on earth.
- **Not `navigator.deviceMemory`.** Chromium-only, so gating on it silently rejects Safari and
  Firefox — the exact outcome this provider exists to avoid.

What it does check: a secure context (a deck served from a LAN IP has no `navigator.gpu` at all,
and that is a normal way to present), an adapter, and that the adapter is not a software
fallback. `shader-f16` is recorded for the info modal rather than required.

**Verified on Chrome 151 / macOS** (Apple, metal-3, `shader-f16`). **Safari 26 and Firefox are
coded for but unverified** — see [§7](#7-pre-flight). Firefox is the bigger unknown: it is not in
the upstream LiteRT measured set at all.

### The model

`gemma-4-E2B-it-web.litertlm`, from the ungated `litert-community/gemma-4-E2B-it-litert-lm`,
**2,008,432,640 bytes** — verified against HuggingFace's `content-length` and used as an exact
integrity check rather than an approximate size.

Of the whole of HuggingFace, only five genuinely web-packaged `.litertlm` files exist, all
Gemma 4, and this is the smallest. The `-web` packaging is load-bearing: a plain `.litertlm`
fails with `Streaming LlmExecutorMetadata section is not supported yet`.

### Storage, across three vendors

The 2 GB cache write is where browsers differ most, so there are two defences and an integrity
check:

- **A storage estimate before the fetch.** If it will not fit, skip the cache and stream
  straight to the engine — "works, re-downloads next time" beats "cannot run the model".
- **A `QuotaExceededError` fallback after it.** Safari reports an aspirational quota and then
  throws anyway; Firefox reports a group limit and has been seen throwing a bare `TypeError`.
  Matched on name _and_ message, because vendors disagree.
- **An exact byte-count check on write and on read, against the response's own
  `content-length`.** A truncated entry is the nastiest failure available: `cache.match` returns
  it happily and the engine fails on partial bytes with a message about wasm sections. A short
  entry is deleted rather than reported. The number comes from the server — live on download,
  and off the cached entry's stored headers thereafter — never from the pinned constant, which
  is a version marker and only warns. See [dependencies.md](dependencies.md).
- **`navigator.storage.persist()` from any deliberate load, not only a fresh download.** Chrome
  grants it silently; Firefox raises a permission doorhanger, and browser chrome appearing
  mid-talk is worse than the eviction it prevents — so it is never called from the mount-time
  probe, which goes through `isCached` and never reaches `getModelSource`. Asking only on a
  cache MISS left an already-downloaded model unprotected forever, which is the state most
  machines are in by the time anyone presents. Note Chrome declines it outright on
  `http://localhost` — measured — so verify this on the real origin, not in dev.

---

## 4. Two phases, and why the download has no deadline

`doLoad()` separates DOWNLOADING from CREATING, and the separation is the whole design. A
`create()` secretly waiting on a download surfaces as "the model took too long to start" —
wrong and unactionable.

- **The download gets no deadline.** 2 GB on venue wifi is legitimately many minutes, and any
  fixed limit is a lie told to a presenter who is merely being patient. What replaces it is a
  **stall detector** — an idle timer that fires only when no bytes are arriving — plus a real
  cancel button, on the provider where the download is ours.
- **Only the create is bounded**, per provider, from `provider.timings`.
- **`session.js` refuses before it ever calls `load()`.** A question typed while downloading is
  told so, with byte counts. One typed while merely DOWNLOADABLE is refused with the size — a
  keystroke is valid user activation, but silently starting a 2 GB fetch from typing is the
  rudest thing this layer could do.

**The mount-time probe never builds an engine.** `chat/index.js` calls `refresh()` and stops
there — it was a `warmUp()` wrapper that did nothing else, so the call and the reasoning now sit
in the same place. The same promotion would claim ~2 GB of GPU memory during
page load, racing Spectacle's 35-slide portal mount. **Safari enforces per-tab memory limits by
killing the tab**, so the worst case is not a slow deck but no deck, before slide 1. The engine
loads in ~1.2s warm, so the first question pays almost nothing for the change.

### The wedge, and `pendingGeneration`

The most important two lines in `model-state.js`. `refresh()` early-returns while a load is in
flight — necessary, or opening the panel mid-download offers a second 2 GB fetch. But
`pendingLoad` was cleared only in `load()`'s `finally`, **which never runs if the load never
settles**, and Chrome's `create()` has been measured to never settle.

A hung load therefore pinned `pendingLoad` forever, `refresh()` early-returned forever, and the
escape hatch — switch back to the other provider — landed in a state machine that could no
longer re-sample anything. _The bail-out was itself wedged._

Fix: anything that invalidates a load bumps `loadGeneration`, and both `refresh()` and `load()`
treat a `pendingLoad` from an older generation as absent. The abandoned promise is then free to
never settle, because nothing waits on it. **The switcher must therefore stay enabled in every
state, including `CREATING`** — an escape hatch disabled while the thing it escapes is happening
is not one.

---

## 5. The abort contract

Aborting has to work in three places, and the same trap exists for both providers:

- **Thread `signal` everywhere.** LiteRT has **no `AbortSignal` support anywhere in its API**;
  `conversation.cancel()` is the only mechanism, so a signal that does not reach that call does
  nothing — generation continues, burning the GPU, until it finishes on its own. Chrome's
  `create()` takes no signal either, which is why the ceiling exists.
- **`stop()` does not wait for the responder.** [`use-conversation.js`](../chat/use-conversation.js)
  bumps a run token, records the partial, and clears `busy` immediately — measured at 11ms.

### `cancel()` poisons the conversation — and how that is survived

The single most surprising measured fact in this layer:

> **One `conversation.cancel()`, from any cause, permanently kills that LiteRT conversation.**
> Every later `sendMessageStreaming` on it rejects with `Error: Task cancelled`. It does not
> recover with time. **`clone()` inherits the poison _and_ loses the history.**

Untreated, that makes the stop button a one-shot: press it once and the assistant is mute for
the rest of the talk. **It stopped mattering** because the provider rebuilds a conversation on
every turn from a transcript it keeps itself ([§6](#6-the-transcript-is-the-providers)) — a
cancelled conversation is thrown away rather than healed. Recorded here because it is real and
will bite anyone reintroducing a long-lived `Conversation`.

### One generation at a time

There is a lock around every LiteRT generation. Because `stop()` deliberately does not wait, a
second `sendMessageStreaming` can be issued while the previous stream is still cancelling, and
the engine has one main executor. Teardown is bounded, because a lock nobody releases is worse
than the overlap it prevents.

---

## 6. The transcript is the provider's

The two providers keep history in opposite places, and the panel is ignorant of both.

**Chrome's session is durable** and owns its own history; there is nothing to rebuild per turn.
**LiteRT's `Conversation` is disposable** — we keep the transcript and rebuild from it every
turn, bounded to three exchanges so re-paid prefill stays flat instead of growing.

That design was originally forced by a measured answer-quality failure. Every turn used to send
700–1500 characters of retrieved slide excerpts with the question; letting a long-lived
conversation accumulate them degenerated answers into _"please provide the context"_ by the
third turn:

|                                         | usable    | context growth (tokens)           |
| --------------------------------------- | --------- | --------------------------------- |
| one conversation, excerpts accumulating | **2 / 5** | 0 → 1364 → 1764 → 2673 → **4338** |
| a fresh conversation per question       | **5 / 5** | 0 every time                      |

**The rebuild-per-turn design stays**, because its _other_ justification (cancel-poisoning, above)
did not go away.

### Deck context: `pin` and `note`

The deck _is_ context again — see [§6a](#6a-what-the-model-knows-about-the-deck) — and the lesson
above is the reason it is shaped the way it is. `stream()` takes two extra arguments, and they
exist as two because they have **opposite lifetimes**:

| arg    | holds                 | lifetime                               | LiteRT                              | Chrome                       |
| ------ | --------------------- | -------------------------------------- | ----------------------------------- | ---------------------------- |
| `pin`  | a slide's text        | sent once, **kept** for the whole chat | its own preface region, untrimmed   | inline; the session keeps it |
| `note` | where the deck is now | sent with this turn, **dropped**       | prepended to the send, not recorded | inline; cannot be dropped    |

`note` **is** the old `remember` seam, restored for the one thing it suited. `pin` is its
opposite, and it is new: `remember` existed to keep per-turn excerpts _out_ of the model's memory,
which is exactly what measured badly above, and which Chrome's durable session cannot express at
any price. So the guidance in the previous version of this section — "put `remember` back rather
than inventing something new" — was half right.

The table's LiteRT column has one rule attached to it: **whatever holds `pin` must be cleared
wherever the transcript is.** `restart()` clears both. Missing that puts two copies of one slide in
a single preface, which is the measured failure in miniature.

### The transcript follows the model's memory

One rule, one place. Anything that drops what the model remembers — the broom, freeing the
session from the status row, deleting the model, **switching providers** — bumps an `epoch` in
`model-state.js`, and the panel wipes the transcript from that. Each used to have to remember
to clear it itself, and freeing the session did not: the window kept showing an exchange the
model had no memory of. A plain `refresh()` deliberately does not clear, because it drops
nothing.

Switching providers is the newest member of that list and the most obviously correct one: the
two models have entirely separate memories, so a carried-over transcript would show an exchange
the new model has never seen.

**`deck-context.js` is now on that list too, and it joined by _reading_ `epoch` rather than by
being told.** Its seen-set is part of what the model remembers, so a broom that cleared the
session but not the set would leave a later turn saying "shown earlier" about content nobody
holds. Deriving the reset from `epoch` — the same trick `ui/panel.js` uses — means the call site
that forgets cannot exist.

---

## 6a. What the model knows about the deck

Two sources, no per-question routing. That last clause is the design: an earlier build chose among
five views per question, and the complexity is most of why it was removed.

| source            | where                         | when                                             |     cost |
| ----------------- | ----------------------------- | ------------------------------------------------ | -------: |
| the deck's spine  | system prompt, built once     | every turn, unavoidably                          | ~700 tok |
| the current slide | `pin`, at most once per slide | the first question asked from it                 |  ~65 tok |
| where it is now   | `note`, per turn              | only when the deck moved since the last question |  ~20 tok |

The spine is `<deck-facts>` (five chapters, six takeaways with their details, the two audiences —
read straight from `deck/chapters.js` and `deck/takeaways.js`) plus `<deck-outline>` (35 titles).
**Not** the whole deck as Markdown: that is 16,100 characters ≈ 4,000 tokens, half the window, and
because LiteRT re-prefills the preface every turn it would add ~2.5s to every answer. It also
carries the speaker notes, which are full of timings and "first cut if we're running long".

### The empty state is the demo

The panel opens on "Ask me about this presentation or the slide you're on" and three chips that
**send on click**, not fill the composer — one tap matters when you are holding a clicker. They run
the three sources in order: the outline, the current slide, the argument. The middle one reads the
bus, so it says _"Summarize slide 21"_ and re-renders on every navigation — the cheapest possible
proof the thing is watching the deck, offered before anyone has typed. It falls back to "this
slide" when the bridge is down.

### The rule that makes it safe

**A slide's text appears at most once per conversation.** Growth is therefore linear in _distinct
slides asked about_, not in turns — which is the difference between this and the 4,338-token soup
above. Bounded by the deck at 35 blocks; five to a dozen in a real talk. There is deliberately no
eviction: dropping content the model has been _told_ it was shown is a dangling reference, which is
the one failure this is built to avoid.

Three consequences fall out of reading position at **send time** rather than on navigation:

- A slide walked past and never asked about never enters context at all.
- Re-asking on the same slide adds nothing.
- The rule is **agnostic to who moved the deck**, so when the chat can navigate itself, a question
  about the slide it just moved to already works — provided the caller reads after `nav.settle()`.

### Animated content is not special

`Appear`-wrapped bullets are in the fiber tree from step 0, so a slide's block holds everything on
it whether or not it has faded in — verified identical on slide 3 before and after stepping. A
question asked early gets the same answer as one asked late; animation is pacing for the room, not
a fact about the deck. Which is why the chat's position line **omits the step index** while the
WebMCP one keeps it: an agent has to advance steps, the chat cannot, and telling a model "step 1 of
4" while handing it all four invites it to reason about a visibility state nothing else reflects.

### Measured, Gemma, 2026-08-16

| Check                                      | Result                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| System prompt                              | 2,965 chars ≈ **~740 tok**                                    |
| One slide block                            | 245–575 chars; **705 with a code pane**                       |
| All code in the deck                       | 3 slides, 1,815 chars ≈ **~450 tok**                          |
| Context after 5 turns / 2 pinned slides    | **1,407–1,470 tok, ~18% of 8,192**                            |
| Same, where both pinned slides hold code   | 1,345 tok — code is close to free at this scale               |
| Turn latency, warm                         | 0.3–1.4s (was ~0.9–1.2s with no context)                      |
| Slide → summary, slide → comparison        | correct, grounded in the pinned block                         |
| "which slide covers vector search?"        | "Slide 15" — correct, from the outline, no navigation         |
| Number → title, on a **fresh** chat        | **4 / 4 correct** (30, 12, 22, 35)                            |
| Number → title, at turn 5 of a full chat   | **wrong** — gave slide 32's title for slide 30, right chapter |
| "What does `sortBy` allow?" on slide 10    | the real enum — `relevance`, `newest`, `oldest`               |
| Slide 11 asked as "how is this different?" | contrasts declarative HTML attrs against `registerTool`       |
| Chrome, same three turns                   | identical behaviour; 1,089 → 1,497 tok                        |

That second-to-last row is the honest limit and it is worth knowing before a demo: **outline recall
degrades as the conversation fills.** A cold question about any slide number is reliable; the same
question at turn five, with two slides pinned and three exchanges of history, drifted to a
neighbouring chapter-5 title. The broom fixes it. This is small-model attention, not a bug in the
outline — the outline was verified correct at the moment it was misread.

One cosmetic tell from the same runs: asked for slide 12's title, the model answered `"What you get
for free [ch1]"`, reading the outline's `[ch1]` tag as part of the title.

---

## 7. Pre-flight

Do this before a talk, on the machine you will present from:

1. **Download the Gemma model** from the state icon, on a connection you trust. ~46s on a fast
   link; assume much longer on venue wifi.
2. **Confirm "on disk"** on that icon, and open the info modal to check the GPU row.
3. **Ask one question on each provider**, and press stop mid-answer once.
4. **Switch providers mid-conversation** and confirm the transcript clears and the next answer
   streams.
5. **If presenting from something other than Chrome**, do all of the above there — and note the
   Chrome pill will be absent, which is correct. Safari 26 and Firefox 145+ are coded for and
   unverified.
6. **Consider the wasm.** ~20 MB from jsDelivr, fetched when the engine is built, so a blocked
   CDN means a cached model that still cannot run. A cold run at the venue is the only way to
   know.

---

## 8. Measured numbers

Chrome 151, macOS, Apple GPU (metal-3, `shader-f16`), `maxNumTokens: 8192`.

| Quantity                             | Gemma (LiteRT)                     | Chrome            |
| ------------------------------------ | ---------------------------------- | ----------------- |
| Model download (fast link)           | 46.2s for 2,008 MB                 | not visible to us |
| Create / engine load, cold           | 3.0s                               | up to 8.5s        |
| Create / engine load, warm           | ~1.2s                              | ~140ms            |
| New conversation (even with history) | ~2ms — the preface prefills lazily | n/a               |
| Restart (the broom)                  | ~2ms, context back to 0            | a full create     |
| Time to first token                  | 74–330ms                           | not measured      |
| Prefill                              | ~1,900–2,000 tokens/sec            | not exposed       |
| Decode                               | ~70 tokens/sec                     | not exposed       |
| A full answer turn                   | ~0.9–1.2s                          | ~1–3s             |
| `busy` cleared after pressing stop   | 11ms                               | 11ms              |
| Context window                       | 8,192 (ours to choose)             | 9,216 (Chrome's)  |
| Context after one short turn         | 127                                | 126               |
| Context on a fresh session           | **0**                              | **~100**          |

That last row is a real asymmetry rather than a bug, and it is visible on screen: press the
broom and the meter drops to 0 on Gemma but to ~100 on Chrome. LiteRT prefills its preface
**lazily**, so nothing has been spent until the first generation and 0 is the honest number.
Chrome counts the system prompt against the window immediately. Both readings are correct for
their provider, which is why neither is normalised away.

### The context window, and why 8,192

Four "limits" are in play for LiteRT and they disagree:

| Source                                                           | Says   | Enforced?                |
| ---------------------------------------------------------------- | ------ | ------------------------ |
| Architecture (`google/gemma-4-E2B-it` `max_position_embeddings`) | 128k   | yes, by the model        |
| `litert-community` model card, in prose                          | 32k    | **no**                   |
| The `.litertlm` file's `LlmMetadata.max_num_tokens`              | absent | nothing to enforce       |
| LiteRT-LM's own default when unset                               | 4,096  | only if you pass nothing |

The file declaring nothing is load-bearing: there is no cap to hit and no way to query one —
[LiteRT-LM #2865](https://github.com/google-ai-edge/LiteRT-LM/issues/2865) is open precisely
because a package's real capacity is not exposed. Whatever we pass is what we get.

So the number came from measurement, with a deck-realistic prompt on an Apple GPU:

| `maxNumTokens` | create | avg ttft | prefill  | decode |
| -------------- | ------ | -------- | -------- | ------ |
| 4,096          | 1154ms | 88ms     | 1577 tps | 72 tps |
| **8,192**      | 1017ms | 86ms     | 1608 tps | 71 tps |
| 16,384         | 1016ms | 83ms     | 1630 tps | 70 tps |
| 32,768         | 1000ms | 93ms     | 1438 tps | 66 tps |
| 131,072        | 1033ms | 865ms    | 37 tps   | 59 tps |

**Every value loads, 128k included, and engine creation is flat** — the KV cache is cheap for
this model because it is multi-query and shares KV across 20 of its 35 layers. The cost is
**decode throughput**, which is the number a presenter actually feels, not the GPU memory you
would expect.

---

## 9. Architecture, in one screen

```
index.html  ──┬── root  →  Deck  →  Template  →  <DeckBridge/>  ──┐
              │                              ├─ <ChatToggle/>     │ publish
              │                              └─ <ToolsToggle/>    │ (bus.js)
              └── chat-root  →  Panel (own createRoot on body) ←───┘ subscribe
                             ├─ ContextGate  → context/modal.js   lazy
                             └─ ToolsGate    → tools/modal.js     lazy

Panel → useConversation(streamAnswer)
          streamAnswer → deck-context.nextContext()   {pin, note, commit}
          streamAnswer → model-state.getSession() → provider chat handle
          model-state  → providers/index.js → { litert, chrome }
```

- **Two React roots.** The panel mounts on `<body>`, outside the deck, because Spectacle's slide
  portal carries a `transform: scale()` and `overflow: hidden`, `TemplateWrapper` is
  `pointer-events: none`, and presenter/overview mode remounts everything inside it.
- **`DeckBridge` is the only hook-using code in the deck tree.** Spectacle calls `template` as a
  _plain function_ during `Deck`'s own render, so hooks written directly in `Template` borrow
  Deck's hook list — which is why `Template` can no longer early-return. The bridge is safe only
  as an _element_, and only if it renders on every slide. **First bridge wins**: overview mode
  renders 35 of them.
- **Closing the panel hides it, never unmounts it.** That is the whole
  disable-without-losing-state mechanism.
- **`states.js` is a leaf module both sides import.** `model-state.js` imports the providers and
  the providers need `STATES`; as one module that is a circular import, and native ESM (no build
  step here) evaluates the provider first, leaving `STATES` in its temporal dead zone.
- **Three integration touchpoints**, and they must be removed together: the stylesheet link in
  `<head>`, the caught dynamic `mountChat()` after `root.render(...)`, and the `DeckBridge` /
  `ChatToggle` / `ToolsToggle` elements in `Template`. Deleting `chat/` while `components.js` still
  statically imports it is the one combination that breaks the deck; the other two fail soft.
- **Five small shared modules, because five things needed each of them.** `chat/store.js` is the
  observable every state holder is built on (`state.js`, `tools/state.js`, `context/state.js`,
  `bus.js`, `model-state.js`); `chat/url.js` is the one reader of `?chat` / `?tools` / `?mcp` /
  `?tool=`; `ui/use-model-state.js`, `ui/use-copy.js` and `ui/use-dismiss-keys.js` are the three
  hooks the panel and both sheets share. Each replaced three to five verbatim copies.

---

## 10. Picking this up next

### Rough edges, known and unfixed

- **Safari 26 and Firefox are coded for but never run.** Everything is verified on Chrome 151 /
  macOS. Firefox is the bigger unknown — not in the upstream LiteRT measured set at all, and
  GPU_ARTISAN's shaders want `shader-f16`. Do this early: a failure there is a renegotiation,
  not a bug fix.
- **The Chrome provider is only as reliable as the Prompt API**, which [§2](#2-the-chrome-prompt-api-as-measured)
  shows is not reliable. It worked the day this was written and did not the day before. The
  switcher is the mitigation and must stay reachable in every state.
- **Chrome's download is invisible.** No byte counts, no cancel, and no completion event for a
  download it started itself — hence the 5s `availability()` poller.
- **Answer quality is a small model's.** Deck context makes it reliably good on the slide in front
  of it and on the outline, which is most of what it will be asked. It stays a 2B model: see the
  degrading outline recall in [§6a](#6a-what-the-model-knows-about-the-deck), and press the broom
  before a demo rather than after five turns.
- **Slide text carries the deck's own TODOs.** Slide 21's matrix notes read "TODO: Full HF,
  crashy." and the model will happily quote them, because they are on the slide and the audience
  can already see them. Presenter notes are excluded; draft slide copy is not, and cannot be.
- **LiteRT logs to `console.error` in two formats**, and a filter for one misses the other: six
  `INFO:`/`WARNING:` lines per engine create, plus glog-style `W0817 … mel_filterbank.cc` and
  `GetProfileSummary not implemented for backend: GpuArtisan` per turn. Benign, not silenceable.
  Filter both `/^(INFO|WARNING|ERROR):\s*\[/` and `/^[IWEF]\d{4} /` before concluding a console
  check has failed. Full detail in [dependencies.md](dependencies.md).
- **Exported PDFs have never had page numbers.** Spectacle passes `slideNumber = 1` for every
  slide in paged mode. Pre-existing and unrelated to the assistant.

### What is deliberately NOT built

- **~~Deck as context, _in the prompt_.~~** Built — see [§6a](#6a-what-the-model-knows-about-the-deck).
- **The chat driving the deck.** It can say _which_ slide to go to and cannot go there. The
  outline resolves "which slide covers vector search" today, so what is missing is the action, not
  the context. Neither provider has grammar-constrained decoding (below), so the likely shape is
  `selectView()` in [`harvest/views.js`](../chat/harvest/views.js) parsing the intent and calling
  [`nav.js`](../chat/nav.js) — which is why that cascade is kept even though the chat bypasses it.
  Read position **after** `nav.settle()` and the rest already works.
- **Invalidating a pinned slide when the deck is edited.** Nothing in the chat can edit, so there
  is nothing to invalidate yet. When there is: a slide pinned at turn 2 and edited at turn 5 leaves
  stale text in the model's context, and on Chrome it cannot be removed. The fix is for the edit
  path to drop that slide from `deck-context.js`'s map so the next question re-pins it.
- **Deck as mutable.** Also removed. If it returns, the durability constraint that mattered
  most: **never `textContent`** — it removes nodes React's fiber still references, and the next
  commit touching that subtree can throw `NotFoundError` from `removeChild` and unmount the
  root. A blank deck, mid-talk. `nodeValue` and `classList` only, plus a chat-owned `<style>`
  regenerated wholesale with every declaration `!important`.
- **A non-streaming `generate()`.** Removed with the router. Note what it cost on Chrome: no
  throwaway session, so a per-turn router meant a full `create()` before every answer.
- **Grammar-constrained decoding.** LiteRT-LM 0.15.0 has none — verified against the type
  declarations, not assumed.

### Verifying a change

The CDP drivers live in the **session scratchpad and are ephemeral**. They are ~60 lines and
quick to rebuild; what is worth keeping is the list of what to check:

| Check                                             | Expected                                                      |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Two turns, second referring back to the first     | the model remembers, on **both** providers                    |
| The broom                                         | transcript → 0 bubbles, context meter → 0, session stays live |
| Switch providers mid-conversation                 | transcript → 0, pill flips, `chat:provider` persisted         |
| Start a load, switch provider **during CREATING** | state resolves off CREATING; a question then streams          |
| After that bail-out, the info modal               | `Engine: not loaded` — the abandoned engine was evicted       |
| Info modal on Chrome                              | no delete button; the `chrome://on-device-internals` note     |
| Info modal on Gemma                               | delete button, GPU / storage / wasm rows populated            |
| 35-slide sweep with the panel open                | zero real console errors; export/print mount no chat          |

And for deck context specifically — all of these are one `nextContext()` call each, no model
needed, which makes them cheap enough to run on every change:

| Check                                 | Expected                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| Ask on a slide, then ask again on it  | full block, then `{ pin: "", note: "" }`                  |
| Walk 5 → 9 → 12, ask only on 12       | 9 never enters the map                                    |
| Ask on 12, go back to 5, ask          | `note` only — no second copy of slide 5                   |
| Broom, then ask about a pinned slide  | re-pinned; provider's block count **1, not 3**            |
| Switch providers                      | map empties                                               |
| `bus.publish({ activeView: null })`   | both empty; nothing pinned, nothing guessed               |
| Question at turn 3 after moving back  | answers about the **current** slide, not the previous one |
| Context viewer after any of the above | pinned region matches; badge counts blocks                |

That last-but-one row is a regression test with a scar: putting the position line in the pinned
region instead of next to the question made the model answer about the previous slide, because the
pinned region lives in the preface and a per-turn fact ended up nowhere near its turn.

The shape of a driver: connect to the already-running Chrome on `:9222`, find a
`localhost:3000` tab, `Runtime.evaluate` an async IIFE returning JSON. **Reload the page between
code edits** — ES modules are cached per page, so an edit is invisible without it, which cost
real confusion twice. And **kill a backgrounded driver before starting another**: one left
running typed into the same tab and polluted several measurements. Give the deck ~5s after a
reload before probing WebGPU: a probe fired at 3s reported "this browser can't run WebGPU" once
and passed on every retry.
