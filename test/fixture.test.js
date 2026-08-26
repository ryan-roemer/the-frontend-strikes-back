/**
 * What a fixture claims, checked against the code that reads it -- with no deck, no model
 * and no DOM.
 *
 * THE CROSS-CHECK IS THE POINT. A fixture states its `expect.calls` independently of the
 * reply string it also carries, so running the real `parseCall` over the reply and
 * comparing is two sources agreeing rather than one source restating itself. That is what
 * the earlier transcript format could not do: there, the expectation was derived from the
 * reply, so the two could never disagree.
 *
 * WHAT NEEDS THE BROWSER, and is therefore in `replay.test.js`: whether the named tool
 * exists, what its arguments do, and whether the slide ends up as `expect.slides` says. All
 * three need the real fiber tree. Everything in THIS file runs in milliseconds, and that is
 * only true while it stays on this side of the line.
 *
 * AND THE THING NEITHER LAYER CAN TEST: whether the prompt makes the model emit these calls
 * at all. A fixture pins what the model SAID. That is upstream of every assertion here,
 * which is exactly why the removal bug these fixtures were written for reached a live demo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { parseCall } from "../chat/agent/act/parse.js";
import { matchSlide, readFixture } from "../chat/replay/fixture.js";

const DIR = new URL("./fixtures/", import.meta.url);

// TOP-LEVEL AWAIT, which is the whole reason the fixture list can drive the test names:
// `node --test` evaluates the module to completion before running anything, so the
// directory read finishes before the first `test()` call has to exist.
const names = (await readdir(DIR)).filter((name) => name.endsWith(".json"));

const load = async (name) =>
  readFixture(await readFile(new URL(name, DIR), "utf8"));

test("there are fixtures to run", () => {
  assert.ok(names.length, "no .json fixtures found");
});

for (const name of names) {
  test(`${name}: every reply parses to the call the fixture claims`, async () => {
    const { turns } = await load(name);

    turns.forEach((turn, i) => {
      const parsed = turn.replies
        .map((reply) => parseCall(reply))
        .filter((call) => call && call.args !== null);

      assert.equal(
        parsed.length,
        turn.calls.length,
        `turn ${i} (${turn.ask}): ${parsed.length} parsed call(s) vs ${turn.calls.length} claimed`,
      );

      turn.calls.forEach((want, n) => {
        assert.equal(parsed[n].name, want.name, `turn ${i} call ${n} name`);
        assert.deepEqual(parsed[n].args, want.args, `turn ${i} call ${n} args`);
      });
    });
  });

  test(`${name}: a turn claiming no calls really has none`, async () => {
    const { turns } = await load(name);

    // THE NEGATIVE ASSERTION, and it is worth as much as any positive one: a prose turn
    // that starts dispatching means `sniff()` has begun reading answers as calls, which on
    // stage looks like a raw fence appearing in the transcript.
    for (const [i, turn] of turns.entries()) {
      if (turn.calls.length) continue;
      for (const reply of turn.replies) {
        assert.equal(
          parseCall(reply),
          null,
          `turn ${i} (${turn.ask}) claims no calls but a reply parses as one`,
        );
      }
    }
  });
}

test("an empty `text` survives parsing, so a removal is expressible", () => {
  // The bug this harness was built after. Nothing downstream ever rejected `text: ""` --
  // `apply.js` accepts an empty replacement and `tools.js` only refuses null -- so this is
  // the line proving the wire format can say "delete this" at all. `repair()` rewrites
  // quotes and strips trailing commas on the way past, and an empty string is the value
  // most likely to be lost to a repair that gets greedy.
  const call = parseCall(
    '```tool edit_text\n{"find": "WebMCP", "text": ""}\n```',
  );
  assert.deepEqual(call, {
    name: "edit_text",
    args: { find: "WebMCP", text: "" },
    raw: '{"find": "WebMCP", "text": ""}',
  });
});

test("a malformed fixture fails by name", () => {
  // `readFixture` is the only validation between a typo and a run that reports nothing
  // useful, so its refusals are worth pinning.
  assert.throws(() => readFixture("{}"), /no `turns` array/);
  assert.throws(() => readFixture('{"turns":[{}]}'), /turn 0 has no `ask`/);
  assert.throws(
    () => readFixture('{"turns":[{"ask":"hi"}]}'),
    /turn 0 has no `replies`/,
  );
});

test("an absent `expect` block means no calls, not no assertion", () => {
  // Absent and empty have to mean the same thing, or writing a fixture for a prose answer
  // is a trap: the turn would assert nothing and pass whatever happened.
  const { turns } = readFixture('{"turns":[{"ask":"hi","replies":["hello"]}]}');
  assert.deepEqual(turns[0].calls, []);
  assert.deepEqual(turns[0].slides, []);
});

/**
 * The line matcher, which is the part of a fixture most likely to lie.
 *
 * A PATTERN THAT MATCHES TOO MUCH IS WORSE THAN NO PATTERN, because it reads like an
 * assertion and is not one -- so the cases below are mostly about what must NOT match. The
 * deck is being rewritten constantly, and `...` exists so a fixture can ignore the bullets
 * it is not testing; it must not also ignore the line it is.
 */
const SLIDE = [
  '<slide n="9" chapter="1" title="How WebMCP works">',
  "title: How works",
  "bullet 1: The page registers tools.",
  "bullet 2: One API: document.modelContext",
  "</slide>",
].join("\n");

test("a full exact line list still matches exactly", () => {
  assert.ok(matchSlide(SLIDE.split("\n"), SLIDE).ok);
  assert.ok(!matchSlide(SLIDE.split("\n").slice(0, 3), SLIDE).ok);
});

test("`...` elides any run of lines, including none", () => {
  assert.ok(matchSlide(["...", "title: How works", "..."], SLIDE).ok);
  assert.ok(matchSlide(["...", "</slide>"], SLIDE).ok);
  assert.ok(matchSlide(["...", "</slide>", "..."], SLIDE).ok);
  assert.ok(matchSlide(["..."], SLIDE).ok);
});

test("`...` does not excuse a line that is actually wrong", () => {
  const bad = matchSlide(["...", "title: How WebMCP works", "..."], SLIDE);
  assert.ok(!bad.ok);
  // The message names the pattern that could not be placed. Without it a trimmed fixture
  // reports "does not match" about a slide whose lines it mostly never looked at.
  assert.match(bad.why, /no line matching "title: How WebMCP works"/);
});

test("order is part of the assertion", () => {
  // Asking for the closing tag BEFORE the title fails, and the hint names the pattern the
  // greedy scan ran out of slide looking for -- which is the useful half of the answer.
  const out = matchSlide(["...", "</slide>", "...", "title: How works"], SLIDE);
  assert.ok(!out.ok);
  assert.match(out.why, /no line matching "title: How works"/);
});

test("a pattern that does not span the whole slide says so", () => {
  // The trap this feature invites: every named line is present and the fixture still fails,
  // because there is no trailing `...` to absorb the rest. The message has to name that or
  // it reads as a mystery.
  const out = matchSlide(["...", "title: How works"], SLIDE);
  assert.ok(!out.ok);
  assert.match(out.why, /leading or trailing/);

  // Adjacency, the other cause of the same branch: `A` then `B` means B on the NEXT line.
  const gap = matchSlide(["title: How works", "</slide>"], SLIDE);
  assert.ok(!gap.ok);
});

test("`re:` matches one line as a regular expression", () => {
  assert.ok(matchSlide(['re:^<slide n="9" ', "..."], SLIDE).ok);
  assert.ok(!matchSlide(['re:^<slide n="12"', "..."], SLIDE).ok);
  // A regex still matches exactly ONE line, so it cannot stand in for `...`.
  assert.ok(!matchSlide(["re:."], SLIDE).ok);
});

test("backtracking finds a match a greedy scan would miss", () => {
  // `[A, ..., B, C]` against `A x B y B C`: taking the first B and demanding C next fails,
  // and the match is real. This is why `matchFrom` is not a left-to-right scan.
  const lines = ["A", "x", "B", "y", "B", "C"].join("\n");
  assert.ok(matchSlide(["A", "...", "B", "C"], lines).ok);
});
