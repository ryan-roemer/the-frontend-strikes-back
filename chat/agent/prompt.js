import { deckFacts, outline } from "./knowledge.js";
import { context } from "./retrieve.js";
import { getSnapshot } from "../bus.js";

/**
 * What the model is told.
 *
 * Budgeted against a MEASURED 9,216-token input window (`contextWindow` on a live
 * session in Chrome 151 -- not the nominal 32k). The split:
 *
 *   system prompt  ~900 tokens, once   -- identity, deck facts, slide outline
 *   per turn       ~500 tokens         -- retrieved slides + the question
 *
 * which leaves the great majority of the window for the conversation itself.
 *
 * The rules are written as short imperatives because a 3B model follows those and
 * ignores prose. "Say you don't know" is first because the failure that matters
 * here is confident invention: this deck is shown to an audience, and a made-up
 * takeaway said with confidence is worse than an admission.
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
