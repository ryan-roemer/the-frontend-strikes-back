/**
 * One turn, with tools.
 *
 * THE WHOLE POINT OF THIS MODULE IS ITS SIGNATURE. `respond({ text, onChunk, signal,
 * onPrompt })` is byte-for-byte the contract `streamAnswer` already satisfies and
 * `use-conversation.js` already drives, so wiring tools into the chat is one identifier
 * changing in `ui/panel.js` and nothing else. The transcript, the abort path, the run
 * token, the error surface and both providers are untouched by tool calling, and can go on
 * being exercised without it.
 *
 * WHERE THIS SITS, AND WHY NOT INSIDE `session.js`:
 *
 *     use-conversation.js   transcript, one in-flight turn        unchanged
 *       v  respond
 *     act/respond.js        THIS. one turn = one or two calls
 *       v  streamAnswer
 *     agent/session.js      readiness, idle timeout, pin/note     unchanged
 *       v  session.stream
 *     providers/*           litert | chrome                       unchanged
 *
 * `session.js` owns everything that is true of ONE call to the model -- is it loaded, has
 * it gone quiet, what deck context does this turn owe. A tool turn is a MULTI-call concern,
 * and folding it downward would put a loop inside the module that owns the idle timeout,
 * which is how the previous attempt at this ended up with a router threaded through the
 * session layer (`docs/chat-handoff.md` §10). Sitting above it means every call in a tool
 * turn gets the readiness gate and the idle timeout for free, with no new state.
 *
 * AT MOST TWO MODEL CALLS, and the second is a retry rather than a loop. See
 * `receipt.js` `retryable`: a refusal carrying candidates is the one case where the model
 * has learned something it can act on. There is no `while`, and that is deliberate -- an
 * unbounded loop over a 2B model is a way to spend thirty seconds arriving nowhere in
 * front of a room, and every case that would need a third call is one where the tools
 * should be taking a phrase instead.
 */
import { streamAnswer } from "../session.js";
import { byName, toolNames } from "./catalog.js";
import { invalidate } from "./invalidate.js";
import { parseCall, sniff } from "./parse.js";
import { callLine, receiptText, retryable } from "./receipt.js";

/**
 * Run one model call, deciding as it streams whether it is an answer or a call.
 *
 * SUPPRESSION IS DECIDED ONCE, from the first few characters, and never reversed. `sniff`
 * returns "unknown" until the reply has committed one way or the other, so nothing reaches
 * the transcript that might have to be retracted -- a fence flashing up and disappearing
 * reads as a bug to everyone watching.
 *
 * An answer streams through untouched, which is the property that matters most here: the
 * pure Q&A turn this deck already demos is not made slower, or more buffered, or in any
 * way different by the existence of tools.
 */
const ask = async ({ text, onChunk, signal, onPrompt }) => {
  let mode = "unknown";

  const answer = await streamAnswer({
    text,
    signal,
    onPrompt,
    onChunk: (accumulated) => {
      if (mode === "unknown") mode = sniff(accumulated);
      // A tool call is not prose and must never be rendered as it decodes. The user sees
      // nothing until the call has run and `receipt.js` has something true to show.
      if (mode === "answer") onChunk?.(accumulated);
    },
  });

  // Re-sniffed on the finished text rather than trusting the streaming verdict: a reply
  // short enough to arrive in one chunk can finish while `mode` is still "unknown".
  if (sniff(answer) !== "call") return { answer, call: null };

  // A REPLY THAT OPENED A FENCE IS A CALL EVEN IF NOTHING PARSED. It was suppressed on the
  // way past, so returning `call: null` here would hand the raw "```tool" back to
  // `use-conversation.js` as the assistant's answer -- the one string this layer exists to
  // keep off the screen. The empty name falls straight into the correction path instead.
  // Reached when the model was cut off mid-block by a stop or the idle timeout.
  return {
    answer,
    call: parseCall(answer) ?? { name: "", args: null, raw: answer.trim() },
  };
};

/**
 * What to tell the model when its call could not be dispatched.
 *
 * BOTH MESSAGES NAME THE FIX, not just the fault. "Unknown tool" leaves a small model to
 * re-derive the roster it was already given; listing the real names turns the retry into a
 * pick. The same reasoning as `target.js` answering a missed phrase with the slide's
 * contents -- a refusal that carries a menu costs one round trip and cannot miss.
 */
const badCall = (call) =>
  call.args === null
    ? `Those arguments were not valid JSON: ${call.raw}\nWrite the block again with correct JSON.`
    : `There is no tool called "${call.name}". The tools are: ${toolNames().join(", ")}.\nCall one of those, or answer without a tool.`;

/**
 * A tool turn, or an ordinary answer.
 *
 * The turn is over the moment a tool runs -- the receipt goes to the transcript and this
 * returns. The exceptions are narrow and each buys a specific thing:
 *
 *   the call did not dispatch     the model is told what was wrong and asked once more.
 *                                 A malformed block is the one failure that is entirely
 *                                 the model's to fix, and it usually does.
 *   the tool refused with         `resolveTarget` handed back candidates rather than
 *   candidates                    guessing, which is new information. The model picks an
 *                                 id and the second call lands.
 *
 * `signal` is threaded through every call, so a stop between the first and second reaches
 * the provider rather than being noticed after it returns. `use-conversation.js` `stop()`
 * has already cleared `busy` by then and discards whatever this resolves with, but the
 * abandoned model call still has to actually stop decoding.
 */
export const respond = async ({ text, onChunk, signal, onPrompt }) => {
  const first = await ask({ text, onChunk, signal, onPrompt });
  if (!first.call) return first.answer;

  let call = first.call;
  let tool = byName(call.name);

  // One correction pass for a block that could not be dispatched at all. `onChunk` is NOT
  // forwarded: the retry's own output is either another call (suppressed) or prose that
  // belongs in the transcript, and `ask` decides which -- but its first attempt's partial
  // output must not appear above it.
  if (!tool || call.args === null) {
    const retry = await ask({
      text: `${badCall(call)}\n\nThe request was: ${text}`,
      onChunk,
      signal,
      onPrompt,
    });
    // Prose after a failed call is a fine outcome: the model decided it did not need a
    // tool, and that answer has already streamed to the transcript through `ask`.
    if (!retry.call) return retry.answer;
    call = retry.call;
    tool = byName(call.name);
    if (!tool || call.args === null) {
      // Said as the assistant rather than thrown. A thrown error renders through the
      // panel's error row, which is where "the model is not available" lives -- and this
      // is a turn that ran fine and produced something unusable.
      const shown = `\`${call.name}\``;
      const message = `I tried to call ${shown} and couldn't put the call together. Try asking in a different way.`;
      onChunk?.(message);
      return message;
    }
  }

  // `tool.call` is the SAME `guard()`ed function `mcp/index.js` handed the host, not a
  // second path to the same tool. The in-page model and a browser extension are running
  // identical code, which is the only version of this worth demoing -- and it means a
  // throw becomes an MCP error result rather than a rejected promise here.
  let result = await tool.call(call.args);
  invalidate(call.name, result);

  if (retryable(result) && !signal?.aborted) {
    const retry = await ask({
      // The candidates come from the result's own text block, which `target.js` writes as
      // "matches 3 nodes. Call again with one of these ids:" followed by the ids. Passing
      // it verbatim is what makes this one round trip: the model reads the same refusal a
      // host agent would.
      text: `${receiptText(call.name, call.args, result)}\n\nPick one and call the tool again. The request was: ${text}`,
      onChunk,
      signal,
      onPrompt,
    });

    if (retry.call) {
      const second = byName(retry.call.name);
      if (second && retry.call.args !== null) {
        call = retry.call;
        result = await second.call(call.args);
        invalidate(call.name, result);
      }
    } else if (retry.answer) {
      // The model answered in prose instead of picking. Already streamed, and a reasonable
      // outcome -- "there are three TODOs, which did you mean?" is a good reply.
      return retry.answer;
    }
  }

  const receipt = receiptText(call.name, call.args, result);
  onChunk?.(receipt);
  return receipt;
};

export { callLine };
