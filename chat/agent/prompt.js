import { deckFacts, outline } from "./knowledge.js";
import { context } from "./retrieve.js";
import { getSnapshot } from "../bus.js";

/**
 * What the model is told.
 *
 * Budgeted against `MAX_NUM_TOKENS` in `providers/litert.js` -- 4,096, which is the
 * KV-cache budget we ask LiteRT for rather than a model ceiling (Gemma 4 itself does
 * 32k). Measured against a live session:
 *
 *   system prompt   ~660 tokens, once  -- identity, deck facts, slide outline
 *   per turn        ~330 tokens        -- retrieved slides + the question
 *
 * so a first turn lands around 990 tokens, about a quarter of the window, and a long
 * conversation still has room. The context meter in the status row is the thing to
 * watch; the broom in the header is the answer when it goes amber.
 *
 * An earlier version of this comment budgeted against a measured 9,216-token Prompt
 * API window and guessed ~900/~500. Both numbers are superseded, and the window is
 * now ours to choose rather than the browser's to impose -- raise `MAX_NUM_TOKENS` if
 * a machine has GPU memory to spare.
 *
 * The rules are written as short imperatives because a 2B model follows those and
 * ignores prose. "Say you don't know" is first because the failure that matters here
 * is confident invention: this deck is shown to an audience, and a made-up takeaway
 * said with confidence is worse than an admission.
 */

const RULES = [
  "Answer only from the deck information given to you. If it is not there, say you do not know.",
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
    "(Answer from the excerpts and deck information above. Be brief. If the answer is not there, say so.)",
  ]
    .filter(Boolean)
    .join("\n");
};
