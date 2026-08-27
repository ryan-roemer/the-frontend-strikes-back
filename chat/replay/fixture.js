/**
 * A replay fixture: what the model said, and what the deck must do about it.
 *
 * JSON RATHER THAN THE TRANSCRIPT A PERSON READS. The context modal's copy button produces
 * a `[User]` / `[Assistant]` transcript, and an earlier version of this parsed it. Nothing
 * about that was hard, but two things about it were wrong for a fixture:
 *
 *   `expect.calls` WAS DERIVED FROM THE REPLY, so the expectation and the thing it checked
 *   came out of the same string. Stated in the fixture instead, it is an independent claim,
 *   and `parseCall` can be checked against it with no deck at all.
 *
 *   THE GOLDEN SLIDE STATE WAS WHATEVER THE MODEL HAPPENED TO BE RE-SENT. `invalidate.js`
 *   re-pins an edited slide, so a transcript carries the state of slides the conversation
 *   looked at -- and carries nothing at all for a call that edits a slide the model is not
 *   on. A recorded fixture asks the deck directly and gets every slide it touched.
 *
 * PURE, AND NO IMPORTS. Two consumers that share nothing: `runner.js` beside it, in the
 * page against a live deck, and `test/fixture.test.js` under `node --test` with no deck, no
 * model and no DOM. One browser-shaped import would end the second, and this is the one
 * piece both layers have to agree on exactly.
 *
 * SLIDE STATE IS AN ARRAY OF LINE PATTERNS, not one string with escaped newlines. Two
 * reasons, and the second is the load-bearing one:
 *
 *   A 12-line slide as a single JSON string is unreviewable, and the diff is the thing a
 *   person reads when a golden comparison fails.
 *
 *   A FIXTURE MUST NOT FREEZE CONTENT IT IS NOT TESTING. This deck is being written; its
 *   bullets change weekly. A fixture that pins a whole slide body to assert one edited
 *   title fails on every unrelated wording change, and a suite that cries wolf gets
 *   deleted. So `"..."` elides any run of lines, and only the lines that matter are
 *   written down.
 */

/**
 * A pattern line that matches any number of lines, including none.
 *
 * A LITERAL `...` IS A REAL POSSIBILITY on this deck -- two slide titles already start
 * with an ellipsis -- so the escape is `re:^\.\.\.$`. Neither of those titles serialises
 * to a line that is exactly `...`, which is why this is a footnote rather than a redesign.
 */
const GAP = "...";

/** Named so the split cannot be mistaken for an escape gone wrong in a patch. */
const NEWLINE = "\n";

/** `re:` marks a pattern matched as a regular expression rather than literally. */
const RE = "re:";

const lineMatches = (pattern, line) =>
  pattern.startsWith(RE)
    ? new RegExp(pattern.slice(RE.length)).test(line)
    : pattern === line;

/**
 * Does the receipt say this?
 *
 * CONTAINMENT, not equality, which is the one way this differs from `lineMatches` and the
 * reason it is its own function. A receipt is a whole bubble -- a call line, a result, a
 * skipped-nodes note -- and a fixture that had to quote all of it would freeze the wording
 * of every message it touches. What a fixture wants to say is "it reported six nodes".
 */
export const receiptMatches = (pattern, text) =>
  pattern.startsWith(RE)
    ? new RegExp(pattern.slice(RE.length), "m").test(String(text ?? ""))
    : String(text ?? "").includes(pattern);

/**
 * Do these patterns describe these lines?
 *
 * BACKTRACKING, NOT GREEDY, and the difference is a real case rather than pedantry. For
 * `[A, "...", B, C]` against `A x B y B C`, a greedy scan takes the first `B`, then demands
 * `C` on the next line, finds `y`, and reports a failure that is not there. Patterns are a
 * dozen lines at most, so the exponential worst case is not reachable in practice.
 */
const matchFrom = (patterns, p, lines, l) => {
  if (p === patterns.length) return l === lines.length;

  if (patterns[p] === GAP) {
    for (let skip = l; skip <= lines.length; skip += 1) {
      if (matchFrom(patterns, p + 1, lines, skip)) return true;
    }
    return false;
  }

  if (l >= lines.length) return false;
  return (
    lineMatches(patterns[p], lines[l]) &&
    matchFrom(patterns, p + 1, lines, l + 1)
  );
};

/**
 * The first concrete pattern that appears nowhere it could -- a BEST-EFFORT HINT for the
 * failure message, not a second verdict.
 *
 * A greedy left-to-right scan, which is why it can only be a hint: it is the algorithm
 * `matchFrom` deliberately is not. When it disagrees with the real matcher the answer is
 * "the lines are there but not in that order", which is what the caller says instead.
 */
const firstMissing = (patterns, lines) => {
  let at = 0;
  for (const pattern of patterns) {
    if (pattern === GAP) continue;
    const found = lines.findIndex(
      (line, i) => i >= at && lineMatches(pattern, line),
    );
    if (found === -1) return pattern;
    at = found + 1;
  }
  return null;
};

/**
 * `{ ok }`, plus why not.
 *
 * Takes the slide as one string because that is what the deck's serialiser hands back, and
 * splits here so there is one place that decides what a line is.
 */
export const matchSlide = (patterns, text) => {
  const lines = String(text ?? "").split(NEWLINE);
  if (matchFrom(patterns, 0, lines, 0)) return { ok: true };

  const missing = firstMissing(patterns, lines);
  return {
    ok: false,
    why: missing
      ? `no line matching ${JSON.stringify(missing)}`
      : // EVERY LINE IS THERE AND THE SHAPE STILL DOES NOT FIT, which has two causes and
        // naming both is the difference between a two-minute fix and a puzzled ten. Either
        // two adjacent patterns matched lines that are not adjacent, or the pattern does
        // not span the whole slide -- a missing leading or trailing `...` is by far the
        // more common of the two.
        "every line is present, but not in that arrangement — check adjacency, and whether the pattern needs a leading or trailing `...`",
  };
};

/** The shape, checked once, so a typo in a fixture fails by name rather than by `undefined`. */
const bad = (message) => {
  throw new Error(`fixture: ${message}`);
};

/**
 * One turn as the runner wants it.
 *
 * `expect.calls` DEFAULTS TO `[]` RATHER THAN BEING OPTIONAL, and the difference is the
 * whole negative assertion. A prose turn with no `expect` block means "this turn must not
 * call a tool" -- which is the only thing that catches a `sniff()` regression leaking a
 * raw fence into the transcript. Absent and empty have to mean the same thing, or writing
 * the fixture for a prose answer is a trap.
 */
const readTurn = (turn, i) => {
  if (typeof turn?.ask !== "string") bad(`turn ${i} has no \`ask\``);
  if (!Array.isArray(turn.replies) || !turn.replies.length) {
    bad(`turn ${i} has no \`replies\``);
  }
  if (turn.replies.some((reply) => typeof reply !== "string")) {
    bad(`turn ${i} has a non-string reply`);
  }

  const expect = turn.expect ?? {};
  const slides = Object.entries(expect.slides ?? {}).map(([number, lines]) => {
    if (!Array.isArray(lines)) bad(`turn ${i}, slide ${number}: not an array`);
    if (lines.some((line) => typeof line !== "string")) {
      bad(`turn ${i}, slide ${number}: a pattern is not a string`);
    }
    // NOT JOINED. Joining was what made a partial pattern impossible to express, and the
    // whole point of `GAP` is that a fixture describes some lines rather than all of them.
    return { slide: Number(number), patterns: lines };
  });

  // WHAT THE TOOL REPORTED, for the turns where the slide text cannot say.
  //
  // A style changes no wording, so `slides` is blank for every `style_node` fixture and
  // the only thing left to assert is the call -- which is identical whether the target
  // resolved to one node or six. That is a fixture that cannot fail, and the receipt is
  // the one place the difference shows: "color: yellow on 6 nodes" against "color: yellow
  // on slide 6, takeaway 1 — ...". Substrings, or `re:` for a pattern, matching how
  // `slides` already spells the same choice.
  const receipt = expect.receipt ?? [];
  if (
    !Array.isArray(receipt) ||
    receipt.some((one) => typeof one !== "string")
  ) {
    bad(`turn ${i}: \`receipt\` must be an array of strings`);
  }

  return {
    ask: turn.ask,
    replies: turn.replies,
    calls: expect.calls ?? [],
    receipt,
    slides,
  };
};

/**
 * Text or object -> `{ meta, turns }`.
 *
 * Accepts a parsed object as well as a string so the runner can be handed a fixture
 * through `Runtime.evaluate` without a second round of escaping.
 */
export const readFixture = (input) => {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(raw?.turns)) bad("no `turns` array");
  return { meta: raw.meta ?? {}, turns: raw.turns.map(readTurn) };
};

/**
 * The lines a turn CHANGED, with everything else elided.
 *
 * RECORDING PRODUCES THE MINIMAL FIXTURE, not the whole slide, and that is the point of the
 * feature rather than a nicety. Writing the full body back is what froze content nobody was
 * testing, so a recorded expectation states the lines that moved and `...` for the rest --
 * which is exactly what a person would have trimmed it down to by hand, minus the trimming.
 *
 * With no `before` -- a slide first seen after the call, so there is nothing to diff -- it
 * falls back to the whole body, because "everything is new" is the honest description of
 * that and a bare `...` would assert nothing at all.
 */
const changedLines = (before, after) => {
  const lines = after.split(NEWLINE);
  if (before === null) return lines;

  const was = new Set(before.split(NEWLINE));
  const out = [];
  for (const line of lines) {
    if (was.has(line)) {
      // One `...` per run of unchanged lines, never two in a row.
      if (out[out.length - 1] !== GAP) out.push(GAP);
    } else {
      out.push(line);
    }
  }
  // A turn that changed nothing has nothing to assert; say so with an empty list rather
  // than a lone `...` that would pass against any slide in the deck.
  return out.length === 1 && out[0] === GAP ? [] : out;
};

/**
 * A recorded run -> the `expect` blocks to write back into the fixture.
 *
 * THIS IS HOW A FIXTURE IS AUTHORED, and why there is no capture UI to build: run it once
 * with the expectations absent, and the deck itself states what happened. Reviewing that
 * diff is the act of accepting it -- the only honest way round, because a hand-written
 * golden slide is a guess about `slideText()`'s output and this is not.
 */
export const recordedExpectations = (report) =>
  report.turns.map((turn) => ({
    ask: turn.ask,
    replies: turn.replies,
    expect: {
      calls: turn.actual,
      slides: Object.fromEntries(
        turn.slides
          .map(({ slide, before, actual }) => [
            String(slide),
            changedLines(before ?? null, actual),
          ])
          .filter(([, patterns]) => patterns.length),
      ),
    },
  }));
