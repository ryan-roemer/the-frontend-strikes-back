---
name: tool-call-triage
description: Diagnose and fix a chat-to-tool failure in this deck — the user pastes a transcript where the on-device model called a tool wrongly, or the deck did not do what they asked. Turns the paste into a root cause, a fix, a recorded regression fixture, and a context-budget check. Use whenever a transcript is pasted, or the user says a chat instruction "didn't work", "did nothing", or "should have worked".
---

# Triaging a chat-to-tool failure

The chat drives the deck's WebMCP tools through a prompt wrapper (`chat/agent/act/`). When a
request fails, the cause is almost never "the model is dumb" — it is usually something the
model was never told, or a refusal that withheld the fix. This skill is the loop for turning
one pasted transcript into a fix that stays fixed.

**The prior is that the fault is ours.** Every failure triaged so far was on our side of the
boundary: a description truncated before the sentence that mattered, one worked example that
taught the wrong argument, a refusal that named no alternative, content shown to the model
that it had no way to address. Read the model's output as evidence about the prompt, not as a
verdict on the model.

## 1. Reproduce before theorising

Never diagnose from the transcript alone. The transcript shows what the model _said_; the
question is what it was _told_.

```
npm run dev                                   # if not already up
# Chrome already running with --remote-debugging-port=9222
```

Open the deck with `?replay` and use the in-page harness:

| want                                | call                            |
| ----------------------------------- | ------------------------------- |
| the exact prompt the model received | `deckReplay.prompt()`           |
| what the reply parsed to            | `deckReplay.parse(reply)`       |
| run a tool directly                 | `deckMcp.call(name, args)`      |
| what a phrase resolves to           | `deckDump.locate(phrase)`       |
| what is addressable on a slide      | `deckMcp.call("get_slide", {})` |
| reset the deck                      | `deckReplay.reset()`            |

**Read the prompt first.** `deckReplay.prompt()` exists precisely because reconstructing it by
hand from `mcp/tools.js` gets the `summarize()` truncation wrong every time — and that
truncation is where these bugs live. Confirm what the model actually saw about the tool it got
wrong before forming any theory.

**Reload the page after every source edit.** ES modules are cached per page; an edit is
invisible without it. This has cost real confusion more than once, and it is why
`test/cdp.js` reloads a reused tab.

### If `npm test` hangs

It stops after the pure-JS tests and never reaches the live-deck ones. Cause so far has
always been a CDP call that never gets answered, and the harness bounds every call
(`CALL_MS`) precisely so this degrades into a skip. If it happens again:

```
curl -s localhost:9222/json/list | grep -o '"url": "[^"]*"' | head -40
```

A working profile can carry twenty-plus page targets. `pages()` filters to the deck's origin
before attaching, because unrelated tabs — two `localhost:4710` wasm spikes, in the case that
caused this — will accept a WebSocket and then answer nothing at all. A `try/catch` cannot
save you there: a promise that never settles is not an exception.

**A fast run is not a suspicious run.** The whole suite in well under a second is normal when
Chrome has the CDN assets warm — `connect()` opening its own tab measured 362ms. Check
`opened`/`reason` from `connect()` before concluding the tests skipped; `ℹ skipped 0` with
passing live tests means they really ran.

## 2. Localise: prompt, addressing, or mechanism

Three places a request dies. Establish which before changing anything.

**Prompt** — the model chose the wrong tool or filled the wrong argument. Check what the
catalog gave it:

```js
// per tool, what the model reads
getTools().map((t) => summarize(t.description, { atLeast: 60 }));
```

A first sentence that is a topic label rather than a statement about arguments is the classic
cause. So is a single worked example: with one example of a tool, the model treats that
example's argument as _the_ argument.

**Addressing** — the call was reasonable but resolved to nothing. Ask whether the thing the
model was shown is actually addressable:

```js
deckDump.locate("<the phrase the model used>");
deckMcp.call("get_slide", {}); // what ids exist, and what text each carries
```

Watch for content the model can _see_ but not _name_. A code pane is the known case: its
`node.text` is the filename while `deck-context.js` pins the full source, so every phrase
quoted out of the code used to resolve to nothing.

**Mechanism** — the call resolved and the tool still refused. Run it directly with
`deckMcp.call` to separate the tool from the model. Check whether some _other_ path to the
same outcome works; if one does, the bug is the affordance, not the capability.

## 3. Prefer fixing the refusal over fixing the model

Ranked by how well they hold up:

1. **Make the refusal carry the fix.** Every refusal in this codebase names the valid set —
   `setStyles` lists the properties, `target.js` lists the candidates. One that says only
   "can't do that" is a bug. Add `retry: true` to its `structuredContent` when the refusal
   names a _reliable_ correction, and `act/receipt.js` `retryable` will give the model a
   second attempt automatically. This converts a dead turn into a working one and costs no
   base context at all — the best kind of fix.
2. **Close the addressing gap.** If the model was shown something it could not name, make it
   nameable. Add a fallback tier rather than changing what existing tiers match — `locate`'s
   `bySource` is the pattern: last, after every ambiguity is already decided, so it cannot
   regress a case that used to work.
3. **Widen the tool.** Collapse two calls into one, or accept a friendlier argument shape.
   Costs a little context; often removes a whole class of failure.
4. **Add prompt text.** Cheapest to write, most expensive to keep — see §5. A worked example
   is worth more than a sentence, but every example is paid on every turn forever.

Do not add a tool. `mcp/tools.js` opens by arguing that every overlapping tool is a coin flip
the model has to win, and eight is already the ceiling.

## 4. Record the fixture from the real replies

The user's pasted transcript already contains the best possible test input: what the model
actually said. Use it verbatim — do not tidy it.

Author the fixture with the real replies and a `PLACEHOLDER` for slide state, then record:

```js
await deckReplay.record(fixture); // -> { expectations }
```

Write the recorded `expect` blocks back, then **cut them down**. A fixture must not freeze
content it is not testing — this deck's wording changes weekly, and a suite that cries wolf
gets deleted. Use `"..."` to elide and `re:` for the one line that matters.

Fixture `meta` earns its keep:

- `about` — what behaviour this pins
- `recorded-outcome` — what went wrong originally, in enough detail to recognise a
  regression
- `guards` — which specific fix this fails without, named so a future reader can tell whether
  deleting some code should break this test

**Then prove it fails.** Revert each half of the fix in turn and confirm the fixture goes red,
with symptoms that point at the cause. A regression test that cannot fail is worse than none —
it is a green light over a hole. Restore afterwards and re-run.

```
npm test
```

If a turn should consume two model replies (a refusal then a correction), the fixture states
two `replies` and two `expect.calls`. The runner reports an unused reply, which is exactly how
a lost retry path shows up.

## 5. Account for the context you just spent

Prompt fixes are not free. The whole preface is re-prefilled on every turn on LiteRT, so a
token added for one rare failure is paid on every answer forever, including the pure Q&A turns
that never call a tool.

Measure, do not estimate:

```js
const cat = catalogText().length;
const sys = systemPrompt().length; // or deckReplay.prompt()
// tokens ~= chars / 4.57 — the ratio implied by prompt.js's measured ~680 for the
// pre-tools preface. There is no tokenizer in the page at prompt-build time.
```

Report the delta with the fix, and update the measured figures in the `catalog.js` header and
the `prompt.js` budget table. Those numbers are treated as contracts in this repo; a stale one
is worse than none.

**Tune thresholds by measurement, not taste.** `MIN_SUMMARY` is 60 because the first-sentence
lengths are 191, 92, 61, 14, 205, 72, 96, 270 — 60 picks out the one broken tool and no other,
where 80 pulls in three more for nothing anybody got wrong. Print the distribution before
choosing a number.

### The periodic review

Every few fixes, ask what the catalog is still carrying that nothing needs. Prompt text
accretes: each addition was justified once, and none of them ever gets deleted. Sweep for:

- **An example whose failure a later fix made impossible.** If a tool description now names
  all three of its modes, the example that existed only to teach one of them may be dead
  weight. Check by deleting it and running the fixtures.
- **Two examples teaching the same thing.** Three `edit_text` examples were justified by three
  distinct modes; a fourth showing a mode already covered is not.
- **Enum values spelled out in prose as well as in the signature.** The signature already
  carries them in full; a description repeating them is paying twice.
- **Anything the model has never got wrong.** Every line in `RULES` and every example should
  trace to a real recorded failure. If nobody can say which, that is the candidate.

Deleting prompt text is a behaviour change and needs the same treatment as adding it: run the
full fixture suite, and check the tokens actually went down.

## Checklist

- [ ] read `deckReplay.prompt()` — confirmed what the model was told, not what you assume
- [ ] localised to prompt, addressing, or mechanism, with a direct `deckMcp.call` to separate model from tool
- [ ] fixed as high up the §3 list as the cause allows
- [ ] fixture recorded from the real replies, cut down to what it tests, `meta` filled in
- [ ] fixture proven to fail with each half of the fix reverted, then restored
- [ ] `npm test` green
- [ ] context delta measured, header figures updated
- [ ] schema drift checked — any new `structuredContent` field declared in its `outputSchema`, any new `locate` match value mirrored in `find_nodes`
- [ ] `npm run format`
