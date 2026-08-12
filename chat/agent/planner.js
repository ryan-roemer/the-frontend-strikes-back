/* global LanguageModel:false, DOMException:false, setTimeout:false, clearTimeout:false */

/**
 * Constrained decoding, on throwaway sessions.
 *
 * A FRESH session per constrained prompt, never the durable chat session and never
 * a clone of it. The reason is a Chrome bug the `web-agents` repo hit head-on and
 * documented (`public/app/agents/prompt-api.js:198-224`):
 *
 *   > As of Chrome 151, a second `responseConstraint` prompt on a session that has
 *   > already served one always rejects with `UnknownError: kErrorUnknown`, well
 *   > below any context limit. `clone()` inherits the state and fails too, and
 *   > `append()` does not avoid it.
 *
 * This deck runs on Chrome 151. So each constrained call gets its own session,
 * seeded with a compact system prompt and destroyed in a `finally`. The prompts are
 * small -- a few hundred tokens -- which keeps the per-turn prefill cheap enough
 * that this costs less than working around the bug would.
 *
 * The durable chat session is left for prose, where it belongs: it keeps the
 * multi-turn history and its context usage is what the meter reports.
 *
 * TODO(PROMPT): every call here can hang indefinitely. See `model-state.js` for the
 * measured platform failure -- `LanguageModel.create()` does not resolve, under any
 * configuration. The timeouts and abort plumbing below are what keep that from
 * becoming an unresponsive panel, but they are mitigation, not a fix.
 */

const PROMPT_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

/** Planner calls are short. A stuck one must not hold the turn open. */
const TIMEOUT_MS = 20000;

const aborted = () => new DOMException("Aborted", "AbortError");

/**
 * Race a promise against a timeout AND the caller's abort signal.
 *
 * Both matter, and for different reasons. The timeout catches a wedged platform; the
 * signal is how the stop button reaches code that is sitting inside an `await`.
 * Without the signal here, pressing stop while the router was thinking did precisely
 * nothing -- the turn ran to completion and only then noticed it had been cancelled.
 */
const guarded = (promise, label, signal) => {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        TIMEOUT_MS,
      );
    }),
    new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) return reject(aborted());
      signal.addEventListener("abort", () => reject(aborted()), { once: true });
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * One constrained prompt, on a session that exists only for it.
 *
 * Returns the parsed object, or throws. JSON.parse is left to throw: with a
 * `responseConstraint` the output is schema-shaped by construction, so a parse
 * failure means something is wrong that a repair heuristic would only hide.
 */
export const decode = async ({
  system,
  message,
  schema,
  label = "planner",
  signal,
}) => {
  if (typeof LanguageModel === "undefined") {
    throw new Error("The Prompt API is not available");
  }
  if (signal?.aborted) throw aborted();

  const session = await guarded(
    LanguageModel.create({
      ...PROMPT_OPTIONS,
      initialPrompts: [{ role: "system", content: system }],
    }),
    `${label} session`,
    signal,
  );

  // The race above can reject while `create()` is still in flight, in which case
  // the session it eventually yields is ours to clean up and nobody else's.
  if (signal?.aborted) {
    try {
      session.destroy();
    } catch {
      /* already gone */
    }
    throw aborted();
  }

  try {
    const raw = await guarded(
      // Hand the signal to Chrome as well, so an abort cancels the generation
      // rather than merely abandoning our end of it.
      session.prompt(message, { responseConstraint: schema, signal }),
      label,
      signal,
    );
    return JSON.parse(raw);
  } finally {
    try {
      session.destroy();
    } catch {
      // Already gone; nothing to do.
    }
  }
};
