/**
 * Replay a recorded fixture against the running deck, and report what actually happened.
 *
 * WHAT THIS TESTS THAT A DIRECT TOOL CALL CANNOT. `window.deckMcp.call('edit_text', …)`
 * proves a tool works. This proves the PATH works: that a given model reply dispatched a
 * given call, that a prose reply dispatched nothing, that one turn consumed one model reply
 * rather than quietly taking two down `respond.js`'s retry path -- and that the slide
 * afterwards says what the fixture says it said.
 *
 * THE MODEL IS A RECORDED CONSTANT, so this is a test rather than an eval. The replay
 * provider (`agent/providers/replay.js`) hands back the fixture's replies in order and
 * ignores its prompt entirely. Nothing is sampled; a run is byte-identical every time.
 *
 * WHAT IT STRUCTURALLY CANNOT TEST is whether the prompt makes the model emit those calls.
 * A fixture pins what the model SAID, which is upstream of every assertion here. That is
 * the boundary, and it is worth stating in the file rather than discovering later: the
 * removal bug this harness was built after lived on the far side of it.
 *
 * RETURNS DATA, NEVER THROWS ON A FAILED EXPECTATION. The only caller is a CDP client
 * reading the result of `Runtime.evaluate`, and an exception there arrives as a stack trace
 * with no report attached -- so a mismatch is a row in `failures` and the run carries on to
 * the next turn. A thrown error means the HARNESS broke, which is a different thing and
 * should look different.
 */
import { parseCall } from "../agent/act/parse.js";
import { systemPrompt } from "../agent/prompt.js";
import { respond } from "../agent/act/respond.js";
import { load, switchProvider } from "../agent/model-state.js";
import { script } from "../agent/providers/replay.js";
import { resetEdits } from "../edit/apply.js";
import { withEdits } from "../edit/patches.js";
import { slideText, slideView } from "../harvest/views.js";
import { getTools } from "../mcp/index.js";
import { nav } from "../nav.js";
import { flag } from "../url.js";
import {
  matchSlide,
  readFixture,
  receiptMatches,
  recordedExpectations,
} from "./fixture.js";

/**
 * Record every tool call for the duration of one turn.
 *
 * PATCHES THE REGISTRY'S OWN `call`, which is the same guarded function a browser extension
 * gets (`mcp/index.js` says so where it builds it). Wrapping a copy would observe a path
 * nothing else uses; wrapping this one observes the real dispatch, arguments included,
 * exactly as they arrived.
 *
 * Monkey-patching is acceptable here for one reason only: this module is never loaded
 * without `?replay`, so nothing in the shipped deck can reach it.
 */
const spyOnTools = () => {
  const tools = getTools();
  const originals = tools.map((tool) => tool.call);
  const calls = [];

  tools.forEach((tool) => {
    const original = tool.call;
    tool.call = async (args) => {
      const result = await original(args);
      // AFTER the call, so the outcome is on the record. A dispatch that was REFUSED still
      // happened, and a fixture asserting on the call alone would score that a pass.
      calls.push({
        name: tool.name,
        args: args ?? {},
        isError: Boolean(result?.isError),
        text: result?.content?.[0]?.text ?? null,
        structured: result?.structuredContent ?? null,
      });
      return result;
    };
  });

  return {
    calls,
    restore: () => {
      tools.forEach((tool, i) => {
        tool.call = originals[i];
      });
    },
  };
};

/** `"9.3"` -> 9. */
const slideOfId = (id) => Number(String(id ?? "").split(".")[0]);

/**
 * Every slide a turn's calls actually touched, read out of their own results.
 *
 * THIS IS WHAT RECORDING A FIXTURE BUYS over reading a transcript. A transcript carries
 * the slides the CONVERSATION was re-sent -- `invalidate.js` re-pins an edited slide -- so
 * an edit aimed at a slide the model is not looking at leaves no golden state behind at
 * all. The tools already report which nodes they changed; this is that, one level up.
 *
 * `undo_edits` reports an edit-log summary and no nodes, so a reset turn contributes
 * nothing here. `meta.slides` is the union'd fallback for exactly that case.
 */
const touchedSlides = (calls) => {
  const found = new Set();
  for (const { structured } of calls) {
    if (!structured) continue;
    for (const one of structured.changed ?? []) found.add(slideOfId(one.id));
    for (const one of structured.nodes ?? []) found.add(slideOfId(one.id));
    if (structured.node?.id) found.add(slideOfId(structured.node.id));
  }
  return [...found].filter(Number.isFinite);
};

/**
 * The deck's own serialisation of one slide, in the form a fixture holds it.
 *
 * `withEdits` IS NOT OPTIONAL, and leaving it out is how this was wrong first time round.
 * A harvested node's text comes from the FIBER TREE, and React never learns about a
 * `nodeValue` write -- that is precisely what makes an edit durable (`apply.js` `setText`
 * says so). So the raw harvest reports the AUTHORED wording no matter what the slide now
 * says, and every golden comparison after an edit failed against text the deck was not
 * showing. `deck-context.js` and `get_slide` both wrap the nodes for the same reason; this
 * has to read the slide the way the deck pins it, not a way of its own.
 *
 * `{ ids: false }` MATCHES `deck-context.js` too. With ids on, every line gains a `9.3`
 * prefix and a fixture recorded one way could never be verified the other.
 */
const slideNow = (number) => {
  const slide = slideView(number);
  if (!slide) return null;
  return slideText({ ...slide, nodes: withEdits(slide.nodes) }, { ids: false });
};

/** Name and arguments only, compared as JSON so a mismatch reports a readable diff. */
const sameCall = (a, b) =>
  a?.name === b?.name && JSON.stringify(a?.args) === JSON.stringify(b?.args);

/**
 * Run one fixture.
 *
 * `record: true` skips every comparison and reports what the deck did, which is how a
 * fixture's `expect` blocks are authored -- see `recordedExpectations` in `fixture.js`.
 */
const run = async (input, { record = false } = {}) => {
  const { meta, turns } = readFixture(input);
  const failures = [];
  const note = (message) => failures.push(message);

  // Slides to snapshot even when no call reported touching them: the reset turns, and
  // anything a fixture wants watched for a change it does NOT expect.
  const watched = (meta.slides ?? (meta.slide ? [Number(meta.slide)] : [])).map(
    Number,
  );

  // A FRESH DECK PER FIXTURE. One leaked edit fails the next twelve comparisons in a way
  // that looks like a real regression, and this harness is meant to be run repeatedly
  // against a long-lived browser.
  resetEdits();

  // `resolveTarget` reads the slide on screen, so "the heading" means nothing until the
  // deck is where the fixture was captured.
  if (meta.slide) await nav.toSlide(Number(meta.slide));

  // Picked by `pick()` under `?replay`, but a stored id or a switch made by hand could
  // have moved it. Said rather than assumed: replaying a fixture against a real model
  // would burn a minute and produce a baffling diff.
  await switchProvider("replay");
  if (!(await load())) {
    return { ok: false, meta, turns: [], failures: ["replay: no session"] };
  }

  const report = [];

  for (const [i, turn] of turns.entries()) {
    // BEFORE the turn, for `changedLines`. Only the watched slides can be snapshotted --
    // which slides a call touches is not known until it has run -- and a slide first seen
    // afterwards records its whole body instead. `meta.slide` covers the ordinary case.
    const before = new Map(watched.map((slide) => [slide, slideNow(slide)]));

    script.load(turn.replies);
    const spy = spyOnTools();

    let receipt = null;
    let error = null;
    // WHAT THE MODEL WAS ASKED, per call in the turn. The replay provider reports it
    // through `onPrompt` like a real one does, and it is the only way to test the wording
    // of a RETRY -- the reply that follows is scripted, so nothing downstream of it can
    // show whether the message that provoked it said the right thing. That mattered once:
    // the retry was handing the panel's "**Couldn't do that.**" back as a user turn and
    // the model read it as being told it could not edit the deck.
    const asked = [];
    try {
      receipt = await respond({
        text: turn.ask,
        onPrompt: ({ message }) => asked.push(message),
      });
    } catch (thrown) {
      // Most often the replay provider refusing an exhausted script, which means this turn
      // asked for a model reply the fixture does not have. That IS the finding.
      error = thrown.message;
    } finally {
      spy.restore();
    }

    const actual = spy.calls.map(({ name, args }) => ({ name, args }));
    const unused = script.pending();

    const slides = [...new Set([...touchedSlides(spy.calls), ...watched])].map(
      (slide) => {
        const want =
          turn.slides.find((one) => one.slide === slide)?.patterns ?? null;
        const got = slideNow(slide);
        // `match: null` FOR A SLIDE NOBODY ASSERTED. `watched` snapshots every turn so a
        // recording pass has something to write, and reporting those as `false` made a
        // clean run look like four failures nothing was checking.
        const verdict = want === null ? null : matchSlide(want, got);
        return {
          slide,
          expected: want,
          actual: got,
          before: before.get(slide) ?? null,
          match: verdict === null ? null : verdict.ok,
          why: verdict?.why ?? null,
        };
      },
    );

    if (!record) {
      if (error) note(`turn ${i} (${turn.ask}): threw — ${error}`);

      // CHECKED PER TURN, not at the end. A turn that consumed two replies where the
      // fixture had one misaligns everything after it, and the cascade fails far from its
      // cause.
      if (unused) {
        note(
          `turn ${i} (${turn.ask}): ${unused} reply(s) unused — the turn ended earlier than the fixture expected`,
        );
      }

      if (actual.length !== turn.calls.length) {
        note(
          `turn ${i} (${turn.ask}): expected ${turn.calls.length} call(s), got ${actual.length}`,
        );
      }
      turn.calls.forEach((want, n) => {
        if (!sameCall(want, actual[n])) {
          note(
            `turn ${i} call ${n}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[n] ?? null)}`,
          );
        }
      });

      // What the tool REPORTED, for the turns where the slide text cannot say -- a style
      // changes no wording, so this is the only assertion that can tell one node from six.
      // `!` NEGATES here too, spelled the same way as in `asked`. "Does not carry a
      // `Skipped:` line" is the assertion that catches a length guard coming back, and a
      // fixture that could only state positives could not express it.
      for (const pattern of turn.receipt) {
        const no = pattern.startsWith("!");
        const body = no ? pattern.slice(1) : pattern;
        if (receiptMatches(body, receipt) === no) {
          note(
            `turn ${i}: receipt ${no ? "still says" : "does not say"} ${JSON.stringify(body)} — got ${JSON.stringify(receipt)}`,
          );
        }
      }

      // What the MODEL was asked, indexed by call within the turn. `null` skips a call, so
      // a fixture can assert on the retry without restating the original question.
      turn.asked.forEach((patterns, n) => {
        if (patterns === null) return;
        for (const pattern of patterns) {
          const got = asked[n];
          const wanted = pattern.startsWith("!");
          const body = wanted ? pattern.slice(1) : pattern;
          const hit = got !== undefined && receiptMatches(body, got);
          // `!` NEGATES, because "does not still say `Couldn't do that`" is the assertion
          // that catches a revert here -- the new wording could be anything, but the old
          // wording coming back is exactly the regression.
          if (wanted === hit) {
            note(
              `turn ${i}: model call ${n} ${wanted ? "still says" : "does not say"} ${JSON.stringify(body)} — got ${JSON.stringify(got ?? null)}`,
            );
          }
        }
      });

      // THE GOLDEN COMPARISON. Only the slides the fixture states are asserted; the rest
      // ride along in the report so a recording pass can pick them up.
      for (const one of turn.slides) {
        const seen = slides.find((s) => s.slide === one.slide);
        if (!seen?.match) {
          // The pattern that could not be placed, rather than "does not match". With
          // elided lines a bare mismatch says nothing about WHICH line was wrong, and the
          // full slide is already in the report for anyone who wants to read it.
          note(
            `turn ${i}: slide ${one.slide} — ${seen?.why ?? "no such slide"}`,
          );
        }
      }
    }

    report.push({
      turn: i,
      ask: turn.ask,
      replies: turn.replies,
      expected: turn.calls,
      actual,
      calls: spy.calls,
      receipt,
      slides,
      unused,
      error,
    });
  }

  return { ok: !failures.length, meta, turns: report, failures };
};

/**
 * Install `window.deckReplay`, or nothing at all.
 *
 * ON `window` AND NOT AN EXPORT, for the same reason `window.deckMcp` is: the only caller
 * is a CDP client evaluating a string in the page, and an ES module's exports are not
 * reachable from `Runtime.evaluate`. This is the seam that makes the runner drivable from
 * outside the browser.
 *
 * Returns a teardown, like the other installs in `chat/index.js`.
 */
export const installReplay = () => {
  if (!flag("replay")) return () => {};

  window.deckReplay = {
    run,
    /** Run with no comparisons and hand back `expect` blocks to write into the fixture. */
    record: async (input) => {
      const report = await run(input, { record: true });
      return { ...report, expectations: recordedExpectations(report) };
    },
    /** For a client checking it attached to the right tab before sending a fixture. */
    ready: () => Boolean(getTools().length),
    /** The one-liner a person types in the console between hand experiments. */
    reset: () => resetEdits(),
    /** What `parseCall` makes of a reply, without running it. */
    parse: (reply) => parseCall(reply),
    /**
     * The prompt as the model receives it.
     *
     * THE ONE THING NO ASSERTION HERE CAN REACH. Every test in this harness runs downstream
     * of a recorded reply, so when the finding is "the model chose the wrong call", the
     * evidence is not in a report -- it is in what the model was told. Reading it is the
     * first step of that diagnosis, and reconstructing it by hand from `mcp/tools.js` gets
     * the `summarize()` truncation wrong every time, which is precisely where these bugs
     * live.
     */
    prompt: () => systemPrompt(),
  };

  return () => {
    delete window.deckReplay;
  };
};
