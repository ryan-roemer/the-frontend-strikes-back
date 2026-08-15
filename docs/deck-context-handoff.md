# Deck context — addressing slide content

The deck can already read itself. [`chat/harvest/`](../chat/harvest/) walks React's fiber tree and
emits the whole deck as one Markdown document — headings, bullets, code panes with their original
source, and speaker notes. That part is built, verified, and described in
[README](../README.md#the-deck-as-markdown).

This document was the handoff for the **next** step, which was not more extraction:

> Add structured DOM/React information to the content so that a user can describe some content in
> the deck in chat, and we have a first-class way to look it up and include pointers to the
> actionable JS-land thing to change.

**That step is now built.** Sections 1–4 have been rewritten to describe what exists rather than
what was proposed; the numbers throughout are re-measured against the built version, not the
prototype. §5 is answered. §6 and §7 are unchanged and still the constraints to respect.

Two capabilities, and they are worth naming separately because they have very different difficulty:

1. **Addressing** — "the second bullet on the WebMCP slide" resolves to one specific node. Easy.
   The fiber tree already carries component identity, and the numbers below say the inventory is
   small. **Done**, and it turned out to have a second half nobody had named: an address is only
   useful if it resolves back to something, and "change the heading color" wants a live DOM element
   where "change this phrase" wants a line of source. Both are built.
2. **Provenance** — that node points back at the JS you would edit. Hard, and **cannot be made
   complete**. §3 has the measurements and why. **Done, and better than the ceiling this document
   predicted** — 7 of 162 nodes are genuinely unlocatable, not the ~19 of 146 estimated, because the
   longest-literal-run fallback §3 recommended recovers more than it was expected to.

Read [chat-handoff.md](chat-handoff.md) first if you have not. It is the record of the model layer,
and §6 and §10 there are load-bearing constraints on anything built here.

---

## 1. What exists now

|                              |                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `chat/harvest/fiber.js`      | React internals, isolated. `rootFiber`, `walk`, `findAll`, `propsOf`, `textOf`, `classOf` |
| `chat/harvest/markdown.js`   | fiber subtree → Markdown, and the node-emission points. Deck-aware (class vocabulary)     |
| `chat/harvest/nodes.js`      | roles, `flattenNode`, `emitNode`, `elementOf`. What makes a text run an addressable thing |
| `chat/harvest/index.js`      | `harvestDeck()`, `harvestSlide()`, `resolveNode()`, `deckMarkdown()`, DOM fallback        |
| `chat/harvest/views.js`      | the four sized views, `selectView()` / `contextFor()`, and `describeNode()`               |
| `chat/harvest/locate.js`     | a phrase a person said → the node they meant, or an honest "which of these"               |
| `chat/harvest/provenance.js` | source pointers and their confidence tier                                                 |
| `chat/harvest/dump.js`       | `window.deckDump` and the `?dump` overlay. Installed by `mountChat()`                     |

`harvestDeck()` returns `{ meta, parts, chapters, takeaways, audiences, verdicts, slides }`, each
slide `{ number, chapter, kind, title, body, source, code, notes, nodes }`, each node
`{ id, slide, ordinal, role, depth, roleOrdinal, text }` plus a **non-enumerable** `fiber`.

The console surface, which is also the whole product for consumer (c) in §5:

```js
deckDump.nodes(); // all 162, addressed
deckDump.node("9.2"); // + the live DOM element
await deckDump.where("9.2"); // + provenance. JSON-safe, for pasting
deckDump.locate("the second bullet"); // a phrase -> the node, or the candidates
deckDump.describe("9.3"); // 'slide 9, bullet 2 — "One API: ..."'
deckDump.context("go to the last slide"); // what a turn would carry, and its size
deckDump.views.position(); // { slide, step, count }
```

Measurements, all reproducible with the driver in §8:

- 35 slides, `source: "fiber"`, headings contiguous 1–35
- 27 slides carry notes; the 7 without are chapter dividers
- 7 markdown slides reproduce their source verbatim; 3 `CodePane` slides carry file + language
- the document is ~16,100 characters
- the text between `<speaker-notes>` tags is byte-identical to the structured `notes` field
- **162 addressable nodes**, ids unique and contiguous per slide
- **the node signature is byte-identical** under `?animate=false`, `?presenterMode=true` and
  `?slideIndex=N` — see §4 on why that had to be checked rather than assumed

**Nothing is wired into the model yet, and that is deliberate.** `chat/agent/prompt.js` still
returns a fixed line and still says the assistant has no access to the slides. The views are built
and measured; connecting them needs the `remember` seam restored
([chat-handoff.md §6](chat-handoff.md)), which is the next piece of work and not this one.

**It IS wired to WebMCP.** [webmcp-handoff.md](webmcp-handoff.md) describes the fourteen tools the
deck registers on `document.modelContext`, which is where all of this gets exercised end to end by
an agent rather than from a console. Read it before the next change here: building it turned up a
bug in this layer that every measurement in this document had missed, because it only appears after
the deck has been navigated (§7).

### A bug this turned up

Slide 21's five matrix rows — every runtime the talk compares — were **absent from the harvest
entirely**. "transformers.js" appeared zero times in a 16,100-character dump of the deck.

`MatrixSlide` builds its rows from bare `Box`es, `Box` is transparent to the serializer, and a
transparent node contributes `inline` text with no block to attach it to. Slide-level inline text is
discarded by `render`, which only emits blocks. Nothing errored and the slide looked fine.

Fixed with `CELL_CLASSES` in `markdown.js`. Worth knowing generally: **a layout primitive carrying a
semantic class is content, not a wrapper**, and the serializer cannot tell the difference without
being told. A coverage check — flatten every text run in a slide's fiber subtree, diff against the
harvested body — finds this class of hole in one pass and found no others.

---

## 2. The inventory is small — measured, not estimated

Every `Heading` / `Text` / `ListItem` / `Quote` / `CodePane` fiber is one addressable node, plus the
matrix cells above:

|                       |                                                                       |
| --------------------- | --------------------------------------------------------------------- |
| addressable nodes     | **162**                                                               |
| per slide             | mean 4.6, min 1, max 13                                               |
| by role               | `bullet` 32, `title` 26, `text` 22, `takeaway` 18, `eyebrow` 12, tail |
| full index as text    | ~7,200 chars ≈ **~1,800 tokens**                                      |
| active slide, typical | ~200 chars ≈ **~50 tokens**                                           |

**Node boundaries are already clean.** Each fiber owns exactly one text run; the string sits one or
two levels down, usually in props rather than in a child fiber (see the trap in §7).
`audience__who` and `audience__claim` are separate `Text` fibers, not one blob. You do not need a
heuristic to find node boundaries — component identity is the boundary.

**Markdown slides needed a second descent.** `serialize()` returns early on `Markdown` — the props
hold the authored source, and descending would report the same content twice — so the 7 markdown
slides had no addressable nodes at all. They do build real components (`deck/components.js` maps
`p` → `Text`, `h1`–`h4` → `Heading`, `li` → `ListItem`), so the existing `Notes` scan under
`Markdown` now emits nodes as well: **33 nodes** that were otherwise unreachable, on the slides
whose provenance is the most exact in the deck.

**Nested list items are nodes too, and getting there took two changes together.** The scan used to
`SKIP` after emitting, so slide 9's three sub-bullets had no id while their text sat glued inside
their parent's — a user could name something visibly on the slide and there was nothing to point at.
Worse, resolving the parent hands back an `<li>` that _contains_ the nested `<ul>`, so a future
rewrite of that element's text would have taken the whole sub-list with it.

The fix is the scan descending **and** `flattenNode` stopping at a nested list, because either alone
is wrong: descending without stopping double-reports the sub-items inside the parent, and stopping
without descending loses them entirely. Together they give one node per visible line. Slide 9 is the
only slide in the deck with a nested list — 32 `ListItem` fibers, 29 emitted before this, and its
three account for the whole gap.

**Node text is the RAW run, not the serialized one.** The two differ more than expected: the author
bio serializes as `![](https://encrypted-tbn0.gstatic.com/...) I lead technology & OSS at
[Nearform](https://nearform.com)`, where most of the tokens are a URL and the phrase a user would
ask to change is split around the markup. `flattenNode` in `nodes.js` is the raw path, and both
emission sites use it so a node's text means the same thing on every kind of slide.

---

## 3. Provenance: 7 of 162 are genuinely unlocatable

The interesting measurement, and it came out better than this document originally predicted. For
each node, can the rendered text be traced back to the JS that produced it?

| tier        | count | what it means                                                                 |
| ----------- | ----: | ----------------------------------------------------------------------------- |
| `data`      |    39 | matches a field in `deck/takeaways.js` or `deck/chapters.js`. Exact — name it |
| `exact`     |    66 | appears exactly once in `index.html`. Search for it                           |
| `partial`   |    17 | the whole run is absent but a span of it is present. `search` holds that span |
| `ambiguous` |    11 | appears more than once. Search, then disambiguate by slide number             |
| `too-short` |    19 | under 10 characters. Not searched — the result would be noise, not a location |
| `file`      |     3 | a code pane. The pointer is the file under `examples/`                        |
| `not-found` |     7 | composed at runtime. `search` is null, and saying so is the honest answer     |

**155 of 162 carry a usable pointer.** The earlier estimate of a hard 60–65% ceiling was measured
before the longest-literal-run fallback existed; that fallback is what moves 17 nodes out of
`not-found`, and it recovers more than the four this document expected.

**The remaining 7 are not a bug — they are the architecture.** All are runtime composition:
`Part A · WebMCP` is assembled from `PARTS` and exists as a literal nowhere; `Episode 01` likewise.

Three causes, only two of which searching can beat:

- **Interpolation** — `em()`, `Link`, `Icon` split a line into literals the rendered text rejoins.
  _Beaten_ by the longest-run fallback: `The page **registers** tools. The agent discovers and calls
them.` renders without the asterisks, but ` tools. The agent discovers and calls them.` matches
  exactly and is a fine thing to `grep`.
- **Structural flattening** — `<br />` and nested lists join text the source keeps apart. _Beaten_
  the same way.
- **Runtime composition** — `` `Part ${PARTS.A.key} · ${PARTS.A.title}` ``. **Not beatable**, and
  the tier says so rather than guessing.

**The design rule that made this work: never emit a confident wrong pointer.** `match` is the field
to read first, and `search` is null rather than misleading when nothing was found. A wrong line
number is worse than no line number, and the last mile is a `grep` the consumer already has.

**Why it fetches `index.html`.** Knowing which tier a node is in is a fact about the source, not
about the fiber tree, and one fetch plus `split().length` answers it exactly. The deleted
`knowledge.js` refused to fetch `index.html` because regexing `htm` template literals is fragile —
that objection is about _extracting_ content and does not reach _counting a literal_, which has no
grammar to get wrong.

---

## 4. The shape that got built

### Addressing

Every node has a short, speakable, stable id: **`slide.ordinal`** — `9.2` is the second addressable
node on slide 9. **Global, not per-slide**: the moment two slides' nodes share a context, per-slide
ordinals collide silently.

Ordinals are **emission order, not a fiber path**. `?animate=false` swaps `Appear` for `Fragment`
and changes every path, so a path-addressed node means different things in the mode you present in
and the mode you debug in. Verified rather than assumed: the full `id:role:text` signature of all
162 nodes hashes identically across a normal load, `?animate=false`, `?presenterMode=true` and
`?slideIndex=20`.

Roles come from component identity plus the class vocabulary, and every entry in the map was
measured against the live tree — an aspirational role for a class nothing renders is a role the
model can never use. Nodes also carry `roleOrdinal`, printed only when the role repeats on that
slide, because "bullet 2" is how a presenter talks and `deck-adapter.js` recorded what its absence
costs: "replace the first bullet" once rewrote a slide title.

**`roleOrdinal` is scoped by DEPTH as well as by role, and that is the whole reason nesting was worth
doing carefully.** Emission order is depth-first, so slide 9's three sub-bullets land between the
third top-level bullet and the fourth. Counted flat per role:

| node                         | flat count   | what a presenter sees |
| ---------------------------- | ------------ | --------------------- |
| Most of this lands on apps…  | bullet **7** | the **fourth** bullet |
| Claude Desktop, over a relay | bullet **4** | the first sub-bullet  |

"The fourth bullet" would have resolved to a sub-bullet — a **confidently wrong** answer, which is
strictly worse than an ambiguous one. Keyed by `role:depth`, each level counts from one and the
count matches the slide. `depthOf()` gets the number from a `.return` climb rather than a counter
threaded through the walk, because the two emission paths reach a `ListItem` differently and a climb
gives the same answer from either.

The `role` itself stays `"bullet"` at every depth — the vocabulary does not fork. Only the spoken
name changes, to "sub-bullet", and the view indents by depth so the model sees the structure for two
spaces:

```
9.4 bullet 3: And the agent can be just about anywhere:
9.5   sub-bullet 1: Claude Desktop, over a local relay
9.6   sub-bullet 2: A browser extension
9.7   sub-bullet 3: Or code running in the page itself
9.8 bullet 4: Most of this lands on apps that keep their backend
```

### Two pointers, because an address has to resolve to something

The brief's "pointers to where that content lives" is two different things, and the use cases
separate them cleanly:

| the request                                | wants                     | built as                        |
| ------------------------------------------ | ------------------------- | ------------------------------- |
| "change this slide's PHRASE_1 to PHRASE_2" | the JS you would edit     | `provenance.js`, §3             |
| "change the heading color of this slide"   | the element on screen now | `resolveNode()` / `elementOf()` |

`resolveNode` **re-walks rather than caching**, on two counts: React double-buffers fibers through
`alternate`, so a fiber held across a commit can be the stale copy; and stamping a `data-chat-ref`
attribute is worse, because React drops attributes it does not own when it recreates a node — the
address would work right up until the slide re-rendered.

**Every slide's elements exist, not just the visible one's.** Measured: 162 of 162 resolve to a
connected element carrying the right text. Off-screen slides are laid out at 0×0 rather than
unmounted, so a zero rect means "not on screen", never "not there" — anything measuring an element
to decide whether it is real will conclude that 34 of 35 slides do not exist.

Read-only throughout, and it must stay that way (§6).

### Resolving what a person said: `locate()`

The model picks an id off the roster it can see, which is the right shape for a model — a wrong pick
is a detectably absent id rather than a silently wrong selector. A **human** should not have to.
`locate(phrase, { slide })` takes what someone would actually say and defaults to the slide on
screen.

An ordered cascade, self-verifying tiers first:

| tier          | example                         | why it is where it is                                                                                                    |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **text**      | "the WebMCP one", "One API"     | The only tier that **cannot be confidently wrong** — the substring is in exactly one node or it is not. So it is first   |
| **ordinal**   | "the second bullet", "bullet 2" | Not self-verifying: there is _always_ a second bullet, so a mistake about the numbering returns a plausible wrong answer |
| **role**      | "the heading"                   | Only when the slide has exactly one                                                                                      |
| **ambiguous** | "TODO" on slide 31              | Several candidates, all returned. **Never pick one here** — what to do about it belongs to the caller (see below)        |
| **none**      | "the fifth bullet" of four      | A specific wrong belief. Returning four candidates would imply one of them is the fifth                                  |

Matching runs both directions — the phrase may quote a fragment of a long bullet, or be the whole
node text pasted back with one word changed. When more than one node matches, **an exact match wins
and nothing else does**: a node whose whole text IS the phrase is what the phrase names, and
anything short of that is ambiguity.

That rule replaced a "shortest hit wins" tie-break, which was wrong in a way worth remembering.
Searching slide 6 for "browser" matched three nodes and returned one of them — as `match: "text"`,
the tier described above as the one that _could not have been confidently wrong_ — because its text
was 32 characters against 43 and 46. **Length is not relevance**; it is a proxy that happens to
correlate sometimes, and a proxy is exactly what a tie-break must not be when the alternative is
discarding real candidates in silence.

**What "ambiguous" should mean is the caller's decision, not this file's.** `locate()` reports what
matched and stops there, because the right answer differs by caller: a tool that EDITS a node has to
refuse, since acting on the wrong one of three is unrecoverable, while a tool that merely REPORTS
can hand back all three and be finished. Collapsing those two into one policy here is what made
`find_node` return an error for a search that had succeeded — see
[webmcp-handoff.md](webmcp-handoff.md).

**Never picking among equals is the load-bearing rule**, and it is not hypothetical: slide 7 carries
"TODO: session + when" three times and slide 31 carries "TODO" three times. Something has to happen
there, and choosing the first is the one option nothing downstream can recover from.

A minimal alias table makes the ordinal and role tiers work at all. `heading` is the load-bearing
entry: the deck has no `<h1>`, so a user saying "heading" means what `roleOf` calls a `title`.

### Echo-back: `describeNode()`

```
slide 9, bullet 2 — "One API: document.modelContext"
```

**The cheapest safety in the whole design.** Every way addressing can go wrong ends the same way — a
right-looking id for the wrong thing — and none of them are visible from the id alone. Resolving it
and quoting the text back makes all of them catchable in one glance, for the cost of one lookup.

It names the slide as well as the node, because that catches the failure that matters most: having
resolved against the wrong slide entirely. And it shares its label helper with the roster renderer,
deliberately — a confirmation that says "bullet" where the roster said "bullet 2" is worse than no
confirmation, because the user agrees to a different thing than the one that will change.

### Views, and why the default is ten times smaller than proposed

| view             | holds                                                           |       size | volatility                      |
| ---------------- | --------------------------------------------------------------- | ---------: | ------------------------------- |
| **position**     | slide N of M                                                    |    ~15 tok | **changes on every navigation** |
| **active slide** | that slide's nodes, with ids and roles                          |    ~65 tok | **changes on every navigation** |
| **outline**      | 35 lines: number, title, chapter, code marker                   |   ~270 tok | stable                          |
| **facts**        | chapters, takeaways, audiences, verdicts, from the data modules |   ~350 tok | stable                          |
| **node index**   | all 162 nodes                                                   | ~1,800 tok | stable                          |

This document originally proposed a default of facts + outline + active slide, ~745 tokens. **The
built default is position + active slide, ~80 tokens**, and the reason is that writing the command
families down changed the answer:

| request                                  | views              | measured |
| ---------------------------------------- | ------------------ | -------: |
| "go to the previous slide"               | position           |    46 ch |
| "go to the last slide"                   | position           |    46 ch |
| "go to slide 10"                         | position + slide   |   166 ch |
| "summarize this slide"                   | position + slide   |   257 ch |
| "change this slide's use of X to Y"      | position + slide   |   257 ch |
| "change the heading color of this slide" | position + slide   |   257 ch |
| "which slide covers WebMCP?"             | position + outline | 1,079 ch |
| "find every TODO in the whole deck"      | position + index   | 7,198 ch |

Three of the six target commands are pure navigation and need **no slide content at all** — a slide
number and a count answer them. The outline, which the old default paid 350 tokens for on every
turn, is read by exactly one family: naming a slide by topic instead of by number.

**Volatility decides placement.** The system prompt is fixed when the session is created —
`model-state.js` calls `systemPromptFn()` inside `provider.acquire()` — so the two volatile views
cannot go there without rebuilding the session on every navigation, which on Chrome is a full
`create()`. facts + outline → system prompt, built once; position + active slide → per turn, through
the `remember` seam.

**Scope is a safety property, not only a budget.** If only the active slide's ids are in context, a
content command _cannot_ address slide 22 — the blast radius is bounded by construction rather than
by the model behaving. That matters more than usual here, because neither provider offers
grammar-constrained decoding ([chat-handoff.md §10](chat-handoff.md)), so no schema is keeping a 2B
model inside the lines.

**The view is chosen in JS, never by the model.** `selectView()` is an ordered cascade — deck-wide
phrase → numbered slide → relative movement → named by topic → default. Two orderings are
load-bearing and both were found by running the six commands through it: rule 2 before rule 3,
because "back to slide 10" contains a relative word but is still a numbered destination; and rule 3
before rule 4, because "go to the last slide" says "go to", which rule 4 would read as naming a
slide and answer with a 270-token outline the request has no use for.

**Per-turn context must not accumulate.** [chat-handoff.md §6](chat-handoff.md) has the measurement
that forced this: excerpts accumulating across one conversation degraded answers to 2 of 5 usable
with context growing 0 → 4,338 tokens, while a fresh conversation per question stayed 5 of 5. When
this is wired up, put the `remember` argument back on `stream()` rather than inventing something
new.

### Retrieval

Still not built, and now less obviously needed: the outline resolves "which slide covers X" for 270
tokens without any retrieval at all. If it does become necessary, `git show ef4c47f^:chat/agent/retrieve.js`
has IDF term-overlap with deck-specific stopwords — deliberately not embeddings, because the corpus
is 35 short slides.

---

## 5. Who consumes the pointer — answered

The question was whether the pointer is for (a) the on-device model editing the live deck, (b) a
human pasting into Claude Code, or (c) Claude Code reading `?dump` directly.

**Built for (b), and (c) came free.** `deckDump.where(id)` is JSON-safe on purpose: it returns the
address, the role, the text, the provenance tier and a description of the element, with no DOM node
or fiber in the payload to make `JSON.stringify` throw at exactly the moment you want to paste it.
`deckDump.node(id)` is the live-handle sibling for console work.

(a) is still a separate bet and nothing here forecloses it — the ids are short, speakable and
enumerable, which is what a constrained-decoding scheme would need if one ever becomes available.
But provenance deliberately stays out of the model's context: `deck/takeaways.js -> takeaways[3].text`
buys a 2B model nothing it can act on, and the ~80-token default is the whole point.

**Navigation is still the thing to build first.** It is the whole pipeline — parse a request, resolve
it against a view, act on the deck, report back — with none of the risk, because it never writes to
the DOM. `chat/bridge.js` already publishes `nav`, `chat/bus.js` already exposes `getSnapshot()`,
and `selectView()` now routes the three navigation commands to a 46-character context. See §9.

---

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

Four more were paid for by the session that built the addressing layer:

| trap                                                                 | symptom                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A layout primitive carrying a semantic class is content              | `MatrixSlide`'s ten `Box` cells were transparent, so their text became slide-level `inline`, which `render` discards. Slide 21 lost every runtime it compares      |
| A non-enumerable `fiber` becomes enumerable the moment you spread it | `resolveNode` re-attached it with `{ ...node, fiber }`; the next `JSON.stringify` walked a cyclic graph. Use `defineProperty` on the copy too                      |
| The serialized text and the raw text are different strings           | node text taken from `kids.inline` carried `**`, `` ` ``, `[text](href)` and `![](src)`. A find-and-replace against it misses, and the URLs are most of the tokens |
| Off-screen slides are laid out at 0×0, not unmounted                 | all 162 elements resolve and are `isConnected`; only the rect is empty. Measuring one to decide whether it exists reports 34 of 35 slides missing                  |

And one by the session that put the deck on WebMCP — the most expensive of the lot, because it
invalidated measurements rather than breaking anything visibly:

| trap                                                                | symptom                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React double-buffers fibers, so `===` on a provider is not identity | `slideFibers()` returned 33 of 35 once the deck had been navigated. Slides 2 and 3 vanished, ids shifted down by two, and `harvestSlide(9)` returned slide 11 under slide 9's name, reporting success |

**Every measurement in this document was taken on a fresh load, which is the one state where that
bug is invisible** — nothing has re-rendered, so every fiber is on its first copy. Navigate before
you measure; it is now the first row of the checklist in §8.

And three by the session that made addressing trustworthy:

| trap                                                               | symptom                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodePane` renders a zero-height `div.step-placeholder` FIRST      | `elementOf`'s child-first walk returned that placeholder for all three code panes — connected, right ancestors, no content. A style applied to it lands on nothing and reports success. Skip empty hosts |
| Depth-first emission makes flat per-role ordinals wrong, not vague | "the fourth bullet" on slide 9 resolved to the first sub-bullet. Scope `roleOrdinal` by `role:depth`                                                                                                     |
| A non-enumerable `fiber` is enumerable again after one spread      | `{ ...node, element }` in `resolveNode` re-exposed the cyclic graph; `returnByValue` over CDP and any debugging `JSON.stringify` both die on it. `defineProperty` on the copy too                        |

Worth stealing regardless of what you build next: the **coverage check** that found the first one.
Flatten every text run in a slide's fiber subtree, diff the words against the harvested body, and
print the difference. It runs in one pass, it found exactly one hole in 35 slides, and a harvest
that silently drops content is otherwise invisible — the output looks fine, there is just less of
it. Do not run this against the DOM: off-screen slides render empty there and every slide looks
perfect.

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

| check                                                  | expected                                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **navigate several slides, THEN run everything below** | unchanged. Every check here once passed on a fresh load while the harvest silently dropped two slides after any navigation — see §7           |
| `window.deckDump.slides().length`                      | 35, `source: "fiber"`                                                                                                                         |
| same, under `?presenterMode=true`                      | still 35, from 70 DOM nodes                                                                                                                   |
| slide headings in the document                         | contiguous 1–35                                                                                                                               |
| notes                                                  | 27 slides; spans between tags byte-identical to the `notes` fields                                                                            |
| code slides                                            | 10, 11, 12 with filenames and languages                                                                                                       |
| `?exportMode=true` / `?printMode=true`                 | `window.deckDump` undefined, no overlay                                                                                                       |
| 35-slide sweep, console open                           | no errors. Filter LiteRT's benign `/^(INFO\|WARNING\|ERROR):\s*\[/` first                                                                     |
| `deckDump.nodes().length`, and ids unique              | 162, ids `slide.ordinal` contiguous from 1 within each slide                                                                                  |
| the `id:role:text` signature, hashed                   | **identical** under normal, `?animate=false`, `?presenterMode=true`, `?slideIndex=N`                                                          |
| every node's `element`                                 | 162 of 162 `isConnected`, `textContent` matching once whitespace is squashed (a code node's text is its filename, so require content instead) |
| `(await deckDump.provenance()).totals`                 | data 39, exact 63, partial 17, ambiguous 11, too-short 19, file 3, not-found 7                                                                |
| `deckDump.context(q).chars` for the six commands       | 46 for relative navigation, 257 for a content command on the active slide                                                                     |
| coverage: fiber text runs vs harvested body            | no slide missing words (see §7)                                                                                                               |
| `document.querySelectorAll("[data-chat-ref]").length`  | 0 — nothing here stamps attributes                                                                                                            |

Plus, for resolution:

| check                                                         | expected                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| the **depth test** — `locate("the fourth bullet")` on slide 9 | `9.8`, and `locate("the first sub-bullet")` → `9.5`. If these fail the numbering is wrong                                                        |
| the `locate` fixture table                                    | 21 of 21 — literal, ordinal, depth, bare role, relative, deliberate miss, deliberate ambiguity                                                   |
| no two nodes on a slide share text                            | only genuine repeats: slide 7's three "TODO: session + when", slide 31's three "TODO". Anything else means a loose list emitted `li` **and** `p` |
| `deckDump.describe("9.5")`                                    | `slide 9, sub-bullet 1 — "Claude Desktop, over a local relay"`                                                                                   |

Three of these exist because assuming them would have been wrong: the signature hash is what proves
ordinals are portable across render modes, the coverage check is what caught slide 21, and the
duplicate-text check is what would have caught a loose-list double-emit. **A fixture table is the
only honest test for `locate`** — the tiers interact, and a change that improves one can silently
break another.

Then `npm run format` — the repo's tuned `lint && pretty`. Run it from the repo root, and check
`git status` after driving the browser: a redirect written with a relative path lands in the repo,
and `pretty` will fail on it rather than on your change.

---

## 9. If you only do one thing

§5 is settled and the extraction is built. What is left is the two halves of actually using it, and
they are not symmetrical.

**Deferred deliberately, and none of it is blocking:**

| #   | gap                                                   | when it matters                                                                                                                                                                                                            |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | the slide view does not mark which nodes are REVEALED | `animateListItems` is on for markdown slides, so at `stepIndex: 1` the user sees two bullets and the roster lists four. "The last bullet" means different things to the two parties. `position()` already carries the step |
| 5   | the alias table is minimal                            | when a real phrasing misses. Do not grow it speculatively                                                                                                                                                                  |
| 6   | `roleOrdinal` does not know about list BOUNDARIES     | only on a slide with two or more separate lists at the same depth. None exist today                                                                                                                                        |
| 7   | ids are stable across render modes, not across EDITS  | only if patches get persisted. This pass demonstrated it: `9.5` used to mean "Most of this lands on apps…" and now means "Claude Desktop, over a local relay"                                                              |

**Wire the views to the model.** The seam is `chat/agent/prompt.js` for the stable half and the
`remember` argument on `stream()` for the volatile half. The one thing not to do is concatenate
context into the question: [chat-handoff.md §6](chat-handoff.md) measured that going from 5-of-5
usable answers to 2-of-5, and `remember` exists precisely to send context without it accumulating in
the transcript. `chat/agent/providers/litert.js` has the note where it was removed;
`chat/agent/providers/chrome.js` has no equivalent and will need one.

### Then: navigation, end to end, before anything touches content

The two command families in §4 look symmetrical and are not.

|               | deck-wide, e.g. "go to slide 10"       | content, e.g. "replace the heading"    |
| ------------- | -------------------------------------- | -------------------------------------- |
| context       | position, ~15 tok — built and measured | active slide, ~65 tok — built          |
| action        | `nav.skipTo`, already published        | DOM mutation, nothing built            |
| if it's wrong | you are on slide 9. Press a key.       | the deck is silently altered, mid-talk |

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
