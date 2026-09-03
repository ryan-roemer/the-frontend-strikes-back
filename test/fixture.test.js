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
import {
  fill,
  resolveAnchor,
  resolveAnchors,
  unfill,
} from "../chat/replay/anchors.js";

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

/**
 * Anchors: the part that decides which slide a fixture is about.
 *
 * A HAND-WRITTEN DECK OF FOUR SLIDES, because the interesting cases are the ones a real
 * deck only has by accident -- two slides of the same shape, a title that repeats, a slide
 * whose content moved somewhere else. All four exist below on purpose.
 */
const DECK = [
  {
    number: 1,
    title: "How WebMCP works",
    chapter: 1,
    text: "title: How WebMCP works\nbullet: One API: document.modelContext",
    labels: ["title", "bullet"],
  },
  {
    number: 2,
    title: "Register a tool",
    chapter: 1,
    text: "title: Register a tool\ncode: register-tool.js",
    labels: ["title", "code"],
  },
  {
    number: 3,
    title: "The wrinkles",
    chapter: 2,
    text: "title: The wrinkles\nbullet 1: a\nbullet 2: b\nbullet 3: c\nbullet 4: d",
    labels: ["title", "bullet", "bullet", "bullet", "bullet"],
  },
  {
    number: 4,
    title: "Takeaway",
    chapter: 2,
    text: "title: Takeaway\nbullet 1: a\nbullet 2: b\nbullet 3: c\nbullet 4: d",
    labels: ["title", "bullet", "bullet", "bullet", "bullet"],
  },
];

test("a string anchor finds the slide by its content", () => {
  assert.deepEqual(resolveAnchor("document.modelContext", DECK), { slide: 1 });
  assert.deepEqual(resolveAnchor("register-tool.js", DECK), { slide: 2 });
});

test("a shape anchor finds a slide without naming anything on it", () => {
  // THE DURABLE FORM, and the reason anchors exist at all: "hide the last bullet" needs
  // four bullets so that `bullet 4` is both addressable and last. Reword every one of them
  // and this still resolves.
  assert.deepEqual(resolveAnchor({ nodes: { bullet: 4 } }, DECK), { slide: 3 });
});

test("an exact node count refuses a slide with more", () => {
  // "At least four" would take slide 1 out of a deck where bullets had been added, and
  // then "the last bullet" resolves to `bullet 7` while the recorded reply says `bullet 4`.
  const wide = [{ ...DECK[0], labels: ["title", ...Array(7).fill("bullet")] }];
  assert.ok(resolveAnchor({ nodes: { bullet: 4 } }, wide).reason);
});

test("clauses narrow, so identical shapes can be told apart", () => {
  assert.deepEqual(
    resolveAnchor({ nodes: { bullet: 4 }, title: "Takeaway" }, DECK),
    { slide: 4 },
  );
  assert.deepEqual(resolveAnchor({ chapter: 2, title: "wrinkles" }, DECK), {
    slide: 3,
  });
});

test("first match wins, and a miss is a reason rather than a guess", () => {
  // Ambiguity resolving to the first slide is deliberate -- see `anchors.js`. A MISS must
  // not be: a fixture about content the deck no longer has is a finding, and returning
  // slide 1 for it would report a pass on a slide nobody meant.
  assert.deepEqual(resolveAnchor({ nodes: { bullet: 4 } }, DECK), { slide: 3 });
  const miss = resolveAnchor("a phrase this deck does not contain", DECK);
  assert.equal(miss.slide, undefined);
  assert.match(miss.reason, /no slide matches/);
});

test("`re:` anchors on a pattern, one line at a time", () => {
  assert.deepEqual(resolveAnchor("re:^title: Register", DECK), { slide: 2 });
  // MULTILINE, matching `receiptMatches`: `^` is the start of a LINE of the slide, not the
  // start of the slide. Without that, anchoring on anything below the title would need a
  // `[\s\S]*` prefix, and every fixture would grow one.
  assert.deepEqual(resolveAnchor("re:^bullet: One API", DECK), { slide: 1 });
  assert.ok(resolveAnchor("re:^bullet: No such line", DECK).reason);
});

test("a number passes through as itself", () => {
  assert.deepEqual(resolveAnchor(7, DECK), { slide: 7 });
});

test("`meta` resolves to the numbers its placeholders stand for", () => {
  const { values, failures } = resolveAnchors(
    { at: "document.modelContext", anchors: { later: { title: "Takeaway" } } },
    DECK,
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(values, { total: 4, later: 4, at: 1 });
});

test("an unresolvable anchor is reported by name", () => {
  const { failures } = resolveAnchors({ at: "nothing here" }, DECK);
  assert.match(failures[0], /anchor `at`/);
});

test("`fill` substitutes values, offsets and keys", () => {
  const out = fill(
    {
      replies: ['```tool go_to_slide\n{"move": "{at+1}"}\n```'],
      expect: {
        receipt: ["slide {at} of {total}", "on slide {at}, bullet 4"],
        slides: { "{at}": ["..."], "{at+1}": ["..."] },
      },
    },
    { at: 8, total: 34 },
  );

  assert.deepEqual(out.replies, ['```tool go_to_slide\n{"move": "9"}\n```']);
  assert.deepEqual(out.expect.receipt, [
    "slide 8 of 34",
    "on slide 8, bullet 4",
  ]);
  assert.deepEqual(Object.keys(out.expect.slides), ["8", "9"]);
});

test("`fill` leaves alone every brace that is not a placeholder", () => {
  // These fixtures carry JavaScript in their replies. `registerTool({` is a brace followed
  // by a newline, and a substitution pass that went near it would corrupt the one thing a
  // fixture must reproduce byte for byte: what the model said.
  const code = 'document.modelContext.registerTool({\n  name: "x",\n});';
  assert.equal(fill(code, { at: 8 }), code);
  // A typo'd name survives intact, so it shows up in a failure message rather than as
  // `undefined` or a throw.
  assert.equal(fill("slide {atx}", { at: 8 }), "slide {atx}");
});

test("`unfill` turns a recorded number back into a placeholder", () => {
  // Recording writes `expect` blocks back into a fixture, so it has to write placeholders
  // or it would quietly undo the whole scheme, one recording at a time.
  const values = { at: 8, total: 34, later: 29 };
  assert.equal(unfill(8, values), "{at}");
  assert.equal(unfill(9, values), "{at+1}");
  assert.equal(unfill(7, values), "{at-1}");
  assert.equal(unfill(29, values), "{later}");
  // Too far from any anchor to be worth expressing as one, and `{total}` is a count rather
  // than a position, so it is never a slide's name.
  assert.equal(unfill(20, values), "20");
});
