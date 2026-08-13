/**
 * The system prompt.
 *
 * A FUNCTION, not a constant, and that is the only interesting thing about this
 * file right now.
 *
 * It used to build ~660 tokens of deck knowledge -- chapters, takeaways, audiences,
 * verdicts, a 35-line slide outline -- all harvested from the live DOM, which is
 * precisely why it could not be a string evaluated at import time. That machinery is
 * gone for now, but the seam it forced is worth keeping: `chat/index.js` hands this
 * over via `setSystemPrompt`, and `model-state.js` calls it at the moment a session
 * is actually created. When the deck becomes context again, only this file changes.
 *
 * Kept deliberately short. Both providers are small on-device models with real
 * context budgets -- 8192 tokens on Gemma 4 E2B -- so a preface long enough to be
 * clever is a preface that costs turns.
 */

const PROMPT = [
  "You are a small AI model running entirely on the user's own machine, inside a slide deck about on-device AI in the browser.",
  "No network request leaves this page when you answer.",
  "",
  "Be brief and direct. Two or three sentences unless asked for more.",
  "If you don't know something, say so plainly rather than guessing.",
  "You have no access to the slides, the web, or any tools -- if asked about them, say that.",
].join("\n");

export const systemPrompt = () => PROMPT;
