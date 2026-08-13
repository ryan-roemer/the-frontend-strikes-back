import { deckFacts, outline } from "./knowledge.js";
import { context } from "./retrieve.js";
import { getSnapshot } from "../bus.js";

/**
 * What the model is told.
 *
 * Budgeted against `MAX_NUM_TOKENS` in `providers/litert.js` -- 8,192, which is the
 * context window we ASK LiteRT for rather than any limit the model imposes. Measured
 * against a live session:
 *
 *   system prompt   ~660 tokens, once  -- identity, deck facts, slide outline
 *   per turn        ~330 tokens        -- retrieved slides + the question
 *
 * so a first turn prefills ~840 tokens and lands the meter around 14%, with roughly
 * twenty turns before the broom is worth reaching for. The context underline on the
 * header bar is the thing to watch; the broom next to it is the answer when it goes
 * amber.
 *
 * An earlier version of this comment budgeted against a measured 9,216-token Prompt
 * API window and guessed ~900/~500. Both are superseded, and the window is now ours
 * to choose rather than the browser's to impose -- see `MAX_NUM_TOKENS` for what the
 * sweep found, including the part that is counter-intuitive: a bigger window costs
 * decode throughput rather than the memory you would expect, and it changes the
 * answers.
 *
 * The rules are written as short imperatives because a 2B model follows those and
 * ignores prose. "Say you don't know" is first because the failure that matters here
 * is confident invention: this deck is shown to an audience, and a made-up takeaway
 * said with confidence is worse than an admission.
 */

const RULES = [
  "Answer only from the deck information given to you. If it is not there, say you do not know.",
  // Without this the model treated a code listing as something it had not been given, and
  // answered "the provided text does not contain enough information" with the source
  // sitting in its own prompt. Saying code counts as deck content is what unlocks it.
  "Some slides show code. Code under CODE SHOWN ON SLIDE is part of the deck — read it and answer from it.",
  "Be brief: two or three sentences unless asked for more.",
  "Refer to slides by number.",
  "Never invent slide content, takeaways, or chapter names.",
];

export const systemPrompt = () =>
  [
    "You are the assistant built into a live slide deck. You answer questions",
    "about the deck and can change it when asked.",
    "",
    "RULES",
    ...RULES.map((rule) => `- ${rule}`),
    "",
    deckFacts(),
    "",
    "SLIDE OUTLINE (number, chapter, title):",
    outline(),
  ].join("\n");

/**
 * One question, with the slides it is about attached.
 *
 * The retrieved text goes in the USER turn rather than the system prompt because
 * it changes every turn -- putting it in the system prompt would mean recreating
 * the session for each question and throwing the conversation away with it.
 *
 * The reminder is repeated after the question, not before: small models weight the
 * last tokens most heavily, which is the same reason joyce appends its citation
 * reminder to the user turn rather than trusting the system prompt alone.
 */
export const answerTurn = (question) => {
  const { activeView } = getSnapshot();
  const activeNumber = activeView ? activeView.slideIndex + 1 : null;

  const retrieved = context(question, { activeNumber });
  const where = activeNumber
    ? `The presenter is on slide ${activeNumber}.`
    : "";

  return [
    retrieved ? `DECK EXCERPTS:\n${retrieved}\n` : "",
    where,
    `QUESTION: ${question}`,
    "",
    // "and the deck information" is load-bearing and was briefly lost while this line was
    // being reworded for code. Without it the model reads "the excerpts" as the ONLY source
    // and refuses things the system prompt already told it: "what are the takeaways?" came
    // back as "I do not have the takeaways listed in the provided excerpt", with all six
    // sitting in `deckFacts()` above.
    "(Answer from the excerpts and the deck information above, including any code shown there." +
      " Be brief. If the answer is genuinely not above, say so.)",
  ]
    .filter(Boolean)
    .join("\n");
};
