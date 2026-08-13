# Deck context — addressing slide content

The deck can already read itself. [`chat/harvest/`](../chat/harvest/) walks React's fiber tree and
emits the whole deck as one Markdown document — headings, bullets, code panes with their original
source, and speaker notes. That part is built, verified, and described in
[README](../README.md#the-deck-as-markdown).

This document is the handoff for the **next** step, which is not more extraction:

> Add structured DOM/React information to the content so that a user can describe some content in
> the deck in chat, and we have a first-class way to look it up and include pointers to the
> actionable JS-land thing to change.

Two capabilities, and they are worth naming separately because they have very different difficulty:

1. **Addressing** — "the second bullet on the WebMCP slide" resolves to one specific node. Easy.
   The fiber tree already carries component identity, and the numbers below say the inventory is
   small.
2. **Provenance** — that node points back at the JS you would edit. Hard, and **cannot be made
   complete**. §3 has the measurements and why.

Read [chat-handoff.md](chat-handoff.md) first if you have not. It is the record of the model layer,
and §6 and §10 there are load-bearing constraints on anything built here.

---

## 1. What exists now

|                            |                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `chat/harvest/fiber.js`    | React internals, isolated. `rootFiber`, `walk`, `findAll`, `propsOf`, `textOf`, `classOf` |
| `chat/harvest/markdown.js` | fiber subtree → Markdown. Deck-aware (class vocabulary)                                   |
| `chat/harvest/index.js`    | `harvestDeck()` → structure, `deckMarkdown()` → document, DOM fallback                    |
| `chat/harvest/dump.js`     | `window.deckDump` and the `?dump` overlay. Installed by `mountChat()`                     |

`harvestDeck()` returns `{ meta, parts, chapters, takeaways, audiences, verdicts, slides }`, each
slide `{ number, chapter, kind, title, body, source, code, notes }`.

Current measurements, all reproducible with the driver in §7:

- 35 slides, `source: "fiber"`, headings contiguous 1–35
- 27 slides carry notes; the 7 without are chapter dividers
- 7 markdown slides reproduce their source verbatim; 3 `CodePane` slides carry file + language
- the document is ~16,100 characters
- the text between `<speaker-notes>` tags is byte-identical to the structured `notes` field

**Nothing is wired into the model yet.** `chat/agent/prompt.js` still returns a fixed line and still
says the assistant has no access to the slides. That file is the seam; the harvest is the other half
of it. Deciding _whether_ the on-device model is the consumer at all is §5, and it is the first
question to settle.

---

## 2. The inventory is small — measured, not estimated

Prototyped by treating every `Heading` / `Text` / `ListItem` / `CodePane` fiber as one addressable
node:

|                        |                                                                 |
| ---------------------- | --------------------------------------------------------------- |
| addressable nodes      | **149** (146 prose + 3 code)                                    |
| per slide              | mean 4.3, min 1, max 13                                         |
| by kind                | `Text` 81, `Heading` 36, `ListItem` 29, `CodePane` 3, `Quote` 0 |
| full inventory as text | ~6,220 chars ≈ **~1,550 tokens**                                |

Two things follow.

**Node boundaries are already clean.** Each `Heading` / `Text` / `ListItem` fiber owns exactly one
text run; the string sits one or two levels down, on the host `div`, usually in props rather than in
a child fiber (see the trap in §6). `audience__who` and `audience__claim` are separate `Text` fibers,
not one blob. You do not need a heuristic to find node boundaries — component identity is the
boundary.

**A full inventory does not fit the prompt, but a slide outline does.** Both providers have a real
input window around 8–9k tokens ([chat-handoff.md §8](chat-handoff.md)). 1,550 tokens of inventory on
top of the ~700 the old deck-facts block cost would crowd out the answer. §4 proposes the two-stage
shape instead.

---

## 3. Provenance is 60–65% solvable, and that is a ceiling

The interesting measurement. For each of the 146 prose nodes, can the rendered text be traced back to
the JS that produced it?

| outcome                               |  count | what it means                                                                                              |
| ------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------- |
| exact, from data modules              | **39** | text matches an entry in `deck/takeaways.js` or `deck/chapters.js`. Deterministic — you can name the field |
| unique verbatim match in `index.html` | **51** | the string appears exactly once in the source                                                              |
| ambiguous                             |     10 | appears more than once (e.g. "TODO: session + when", three times on slide 7)                               |
| too short to search                   |     27 | under ~10 characters; needs structural context, not string matching                                        |
| not found                             | **19** | the string does not exist as a literal anywhere. 4 recoverable from the longest literal run, 15 not        |

So roughly **90 of 146 resolve cleanly**, 94 with a longest-run fallback.

**The 19 misses are not a bug to fix — they are the architecture.** Sampled:

```
1  Heading:  "THE FRONTENDSTRIKES BACK"      source has <br /> between the words
3  Text:     "I lead technology & OSS at Nearform"   source interpolates a <${Link}>
4  Heading:  "The frontend is back."          source is `The frontend is ${em("back")}.`
6  Text:     "Part A · WebMCP"                source is `Part ${PARTS.A.key} · ${PARTS.A.title}`
9  ListItem: "And the agent can be anywhere: Claude Desktop…"  nested list flattened
```

Three distinct causes, none of which string search can beat:

- **Interpolation** — `em()`, `Link`, `Icon` split a line into literals the rendered text rejoins.
- **Runtime composition** — "Part A · WebMCP" is assembled from `PARTS` at render time and exists as
  a literal nowhere.
- **Structural flattening** — `<br />` and nested lists concatenate text that is separate in source.

### What to do about it

**Do not build an exact source locator.** Emit tiers and be honest about which tier a node is in:

| tier            | what to emit                                               | reliability                                      |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| address         | slide number + role + ordinal (`slide 9, bullet 2`)        | **always**                                       |
| data pointer    | `deck/takeaways.js → takeaways[3].text`                    | exact, for the 39                                |
| search key      | longest literal run between interpolations                 | best effort                                      |
| provenance kind | `data` / `markdown-source` / `htm-inline` / `example-file` | derivable from the slide's `kind` for every node |

The last mile is a `grep`, and whoever consumes this almost certainly has one. A search key plus a
slide number is enough for an agent to find the line; a wrong line number is worse than no line
number.

The 39 data-module nodes deserve special treatment: they are exact, and they are also the most likely
edit target in the whole deck — the six claims the talk makes. `takeaways.js` says it exists so the
same claim cannot drift across three slides, which is precisely why an edit there is worth pointing
at over an edit to a rendered node.

---

## 4. Proposed shape

Nothing here is built. It is where the measurements point.

### Addressing

Give every node a short, speakable, stable id: **`slide.ordinal`** — `9.2` is the second addressable
node on slide 9. Short ids matter because whatever emits them may be a 2B model (§5).

Derive `role` from component identity plus the deck's class vocabulary, the way `markdown.js` already
does for serialization: `title`, `subtitle`, `bullet`, `takeaway`, `takeaway detail`, `card label`,
`audience`, `matrix row`, `code`. The deleted `deck-adapter.js` had exactly this map (`ROLES`,
`roleOf()`) and one lesson worth inheriting: **number same-role siblings**. "Replace the first bullet"
once targeted a slide title because three sibling `<div>`s all came back as plain "text" with nothing
to distinguish them. With fiber identity that failure is less likely, but "bullet 3" is still how a
presenter speaks.

### Views: deck-wide, active-slide, and the escalation between them

Commands do not all need the same context, and sizing them separately is what makes this fit. "Go to
slide 10" needs the outline and nothing else. "Replace WebMCP in the heading and the second bullet
with BONGOS" needs one slide in full detail and no other slide at all.

Four views, measured:

| view             | holds                                                           |       size | volatility                      | serves                                |
| ---------------- | --------------------------------------------------------------- | ---------: | ------------------------------- | ------------------------------------- |
| **facts**        | chapters, takeaways, audiences, verdicts, from the data modules |   ~350 tok | stable                          | "what is this talk about"             |
| **outline**      | 35 lines: number, chapter, title, code marker                   |   ~350 tok | stable                          | navigation, "which slide covers X"    |
| **active slide** | that slide's ~4.3 nodes, with ids and roles                     |    ~45 tok | **changes on every navigation** | content edits, "what's on this slide" |
| **node index**   | all 149 nodes                                                   | ~1,550 tok | stable                          | cross-deck find/replace only          |

**The default should be facts + outline + active slide — about 745 tokens.** That covers both example
commands with no retrieval at all, which is the point: retrieval is for the minority case where the
user means a slide they are not on.

**Volatility decides placement, not just size.** The system prompt is fixed when the session is
created — `model-state.js` calls `systemPromptFn()` inside `provider.acquire()`. Putting the active
slide there means rebuilding the session on every navigation, and on Chrome that is a full
`create()`, not the ~2ms throwaway LiteRT allows. So:

- facts + outline → **system prompt**, built once
- active slide → **per turn**, through the `remember` seam [chat-handoff.md §6](chat-handoff.md)
  describes, so it is sent without accumulating in the transcript

That split falls straight out of the measurement in §6 there and is the main reason to keep `remember`
rather than concatenating context into the question.

**The bridge already supplies the active slide, and is still unconsumed.** `chat/bridge.js` publishes
`activeView`, `slideCount`, `slideIds` and a `nav` object (`skipTo`, `stepForward`, `stepBackward`,
`advanceSlide`, `regressSlide`) onto `chat/bus.js`. Read it with `getSnapshot()` — a plain function,
no React needed, so the harvest can use it as easily as the panel can.

**Ids must be global, not per-slide.** `9.2`, never `b2`. The moment retrieval pulls a second slide's
detail alongside the active one, per-slide ordinals collide silently.

**Scope is a safety property, not only a budget.** If only the active slide's ids are in context, a
content command cannot address slide 22 — the blast radius is bounded by construction rather than by
the model behaving. The deleted build reached for a router and a JSON planner to get similar safety;
narrowing the view is cheaper and does not depend on structured output the small models cannot
reliably produce (§5).

**Choose the view in JS, not in the model.** Same reason. A deterministic rule — mentions a slide
number or chapter → outline; says "this slide" or names no slide → active slide; says "every" or
"all slides" → escalate to the node index — costs nothing and cannot hallucinate. Do not build a
model-driven view selector.

**Per-turn context must not accumulate.** [chat-handoff.md §6](chat-handoff.md) has the measurement
that forced the current design: excerpts accumulating across one conversation degraded answers to
2 of 5 usable, with context growing 0 → 4,338 tokens, while a fresh conversation per question stayed
5 of 5. If retrieval returns, put the `remember` argument back on `stream()` rather than inventing
something new.

### Retrieval

The deleted `retrieve.js` did IDF term-overlap over 35 slides and deliberately not embeddings —
"the corpus here is 35 short slides". Over 149 nodes that reasoning holds even better. Recover it with
`git show ef4c47f^:chat/agent/retrieve.js`; its stopword list already includes deck-specific words
(`deck`, `slide`, `talk`, `presentation`).

---

## 5. The question to settle first: who consumes the pointer?

This changes everything downstream and is genuinely open.

**(a) The on-device model, to edit the live deck.** Hardest. It needs reliable structured output from
Gemma 4 E2B or Gemini Nano, and [chat-handoff.md §10](chat-handoff.md) records that LiteRT-LM 0.15.0
has **no grammar-constrained decoding** — verified against the type declarations, not assumed. The
previous build's `plan.js` / `planner.js` / `schema.js` were solving this and were removed. If you go
here, read the mutation constraint in §6 before writing a line.

**(b) The human, to paste into Claude Code or an editor.** Much easier and probably where the value
is. The chat answers "that's slide 9, bullet 2 — it's in the chapter-1 markdown set in `index.html`,
search for `One API`", and a capable agent takes it from there. No structured output required from the
small model; it can answer in prose.

**(c) Claude Code directly, reading `?dump`.** Already works today, with no new code. If the goal is
"help me change the deck", a session that reads the dump and greps the repo may be the whole product.

A reasonable read of the brief — "_we_ have a first-class way to look up / include pointers" — is that
the pointer is for tooling and humans, not for the 2B model to act on. If so, build (b), get (c) free,
and treat (a) as a separate bet. **Confirm this before building.**

---

## 6. Constraints inherited — do not rediscover these

**Never `textContent` if mutation returns.** [chat-handoff.md §10](chat-handoff.md): it removes nodes
React's fiber still references, and the next commit touching that subtree can throw `NotFoundError`
from `removeChild` and unmount the root. A blank deck, mid-talk. `nodeValue` and `classList` only,
plus a chat-owned `<style>` regenerated wholesale with every declaration `!important`.

**Identity, never name.** Spectacle arrives minified: `Notes` is `Br`, `Slide` is `Uo`, `Deck` is
`ri`. `fiber.type === Notes` works; `fiber.type.name` matches nothing, silently.

**Presenter mode mounts every slide twice** — 70 `Slide` fibers, 70 `.slide` nodes. `index.js` groups
by nearest `DeckContext` provider and keeps the first group. Any new sweep needs the same guard, or
it double-counts.

**`?animate=false` changes the tree.** `AppearComponent` is `Appear` normally and `Fragment` when
animations are off, so fiber index paths differ between modes. If you address nodes by path rather
than by ordinal-within-role, they are not portable across that flag. Ordinals are safer.

**`walk(node)` is not "this subtree".** It follows the entry node's siblings too. Every current caller
wants that, but flattening one node's text with it silently glues on later siblings. The comment on
`walk` in `fiber.js` now records this; it cost an hour and produced a wrong provenance number before
it was caught.

---

## 7. Traps already paid for

All five were found and fixed in the session that built the harvest. They are in the code with
comments; this is the index.

| trap                                                                                            | symptom                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| React does not create a fiber for a single string child                                         | 25 of 35 slide titles, every card label and every code filename silently missing — text sits in `props.children`, `fiber.child` is null |
| `Notes` nests the _opposite_ way inside `Markdown`                                              | markdown slides came back noteless; `MdNotes` puts `Markdown` inside `Notes`, Spectacle puts `Notes` inside `Markdown`                  |
| `Link` / `Image` wrap host elements with the same props                                         | `[[](https://nearform.com)](https://nearform.com)` — handle the host tag only                                                           |
| Spectacle leaves the `Notes:` line in the source it parsed                                      | every markdown slide printed its notes twice                                                                                            |
| `indentNormalizer` takes the shortest indent across _all_ lines, then guards with a falsy check | one line at column 0 disables dedenting entirely; demo-slide notes rendered as syntax-highlighted code blocks                           |

Also fixed, deck-side rather than harvest-side, and worth knowing if you touch presenter notes:
`deck/styles.css` now scopes the notes rules to `#root` so they win on specificity rather than
`!important`, and `MdNotes` dedents each composed piece before joining.

### Still open, deck-side

`Notes:` on a markdown slide is parsed by
`/^Notes: (.*)$/` against **the first text child only**
(`src/utils/remark-rehype-presenter-notes.ts`, readable via
`https://cdn.jsdelivr.net/npm/spectacle@10.2.3/lib/index.mjs.map`, which carries full
`sourcesContent`). Consequences: content after the first `**bold**`, `` `code` `` or `<span>` is
deleted from both the note and the slide; a real newline makes the regex fail entirely and the raw
`Notes:` line renders as slide content. There is an unused escape hatch in the same file —
`zone(tree, 'notes', …)`, driven by `<!--notes-->` … `<!--/notes-->` comment fences — which takes
nodes wholesale with no regex. **Unverified against 10.2.3.** If you adopt it, notes still compile
with no component map, so the `#root p` rule in `deck/styles.css` needs `ul`/`li` entries too.

---

## 8. Verifying a change

Dev server on `:3000`, Chrome CDP on `:9222`, both already running. The driver is ~40 lines of Node
with the built-in `WebSocket` (Node 24), connecting to the `localhost:3000` tab and
`Runtime.evaluate`-ing an async IIFE that returns JSON. Rebuild it; it is not worth keeping.

Two things that cost real time:

- **Reload the page between code edits.** ES modules are cached per page; an edit is invisible
  without it.
- **`npx serve` redirects `/foo.html` → `/foo` and drops the query string.** Request the extensionless
  path when you need URL params.

What to check:

| check                                  | expected                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `window.deckDump.slides().length`      | 35, `source: "fiber"`                                                     |
| same, under `?presenterMode=true`      | still 35, from 70 DOM nodes                                               |
| slide headings in the document         | contiguous 1–35                                                           |
| notes                                  | 27 slides; spans between tags byte-identical to the `notes` fields        |
| code slides                            | 10, 11, 12 with filenames and languages                                   |
| `?exportMode=true` / `?printMode=true` | `window.deckDump` undefined, no overlay                                   |
| 35-slide sweep, console open           | no errors. Filter LiteRT's benign `/^(INFO\|WARNING\|ERROR):\s*\[/` first |

Then `npm run format` — the repo's tuned `lint && pretty`.

---

## 9. If you only do one thing

Settle §5. Everything else is downstream of whether the pointer is for a 2B model, a human, or an
agent with `grep`. The measurements say addressing is easy, provenance tops out around two-thirds,
and the honest design leans on the consumer's ability to search — which makes the answer to §5 the
whole design, not a detail of it.

### Then: navigation, end to end, before anything touches content

The two command families in §4 look symmetrical and are not.

|               | deck-wide, e.g. "go to slide 10" | content, e.g. "replace the heading"    |
| ------------- | -------------------------------- | -------------------------------------- |
| context       | outline, ~350 tok                | active slide, ~45 tok                  |
| action        | `nav.skipTo`, already published  | DOM mutation, nothing built            |
| if it's wrong | you are on slide 9. Press a key. | the deck is silently altered, mid-talk |

Navigation is the whole pipeline — parse a request, resolve it against a view, act on the deck,
report back — with none of the risk, because it never writes to the DOM. It is also nearly free:
`chat/bridge.js` already publishes `nav`, and `chat/bus.js` already exposes `getSnapshot()`.

Build that first. It proves the loop, exercises the view-selection rule, and tells you how well a 2B
model handles even trivial resolution before you find out with an edit that cannot be undone.

Two things to recover rather than rewrite, both in `git show ef4c47f^:chat/deck-adapter.js`:

- **Spectacle's relative-navigation functions return `undefined`, not a boolean.** `!!deckNav.advanceSlide()`
  was always false, so every working "next slide" reported "I couldn't move the deck." Report success;
  Spectacle clamps at both ends, so a call at the last slide is a no-op rather than a failure, and the
  move lands via a React state update so comparing indices before and after reads the old value.
- **`skipTo` needs BOTH indices.** It merges into the pending view, so omitting `stepIndex` carries the
  previous slide's step onto the new slide. It also does no bounds checking — an out-of-range index
  leaves the deck pointing at no slide, which self-cancels and looks like the command was ignored.

There is also a `BroadcastChannel("spectacle_presenter_bus")` `{type:"SYNC"}` fallback in that file for
when the bridge is unmounted. Note that it did **not** work when tried from the same tab in this
session's presenter-mode testing — `?slideIndex=N` on load did. Verify before relying on it.
