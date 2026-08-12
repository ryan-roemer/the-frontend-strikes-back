/* global AbortController:false, DOMException:false, setTimeout:false, clearTimeout:false */
import {
  getSession,
  getState,
  isReady,
  load,
  modelSize,
  STATE_META,
  STATES,
  touch,
} from "./model-state.js";
import { answerTurn } from "./prompt.js";

/**
 * Talking to the durable session.
 *
 * Streaming only. It is what makes an on-device model feel usable: measured on Gemma
 * 4 E2B over WebGPU, time-to-first-token is ~50ms warm but decode runs at ~65
 * tokens/sec, so a non-streamed answer of any length reads as a hang.
 *
 * The PROVIDER yields deltas; this module accumulates them and hands `onChunk` the
 * accumulated string. Both reference repos do it here rather than in the provider,
 * and the reason is worth keeping: the UI then renders a self-contained string every
 * time, so a dropped or reordered chunk cannot desync the display, and partial
 * markdown still renders.
 */

/** Long enough for a slow first token on a cold model, short enough that a
 *  wedged session doesn't look like a wedged deck. */
const TIMEOUT_MS = 45000;

/**
 * Reject if the model produces nothing for this long.
 *
 * A per-STREAM deadline would punish a long, healthy answer; this is an idle
 * timer, reset by every chunk, so it only fires when the model has actually
 * stopped talking.
 */
const withIdleTimeout = (signal) => {
  let timer = null;
  const controller = new AbortController();
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error("The model stopped responding")),
      TIMEOUT_MS,
    );
  };
  const stop = () => clearTimeout(timer);
  signal?.addEventListener("abort", () => controller.abort(signal.reason));
  arm();
  return { signal: controller.signal, arm, stop };
};

const aborted = () => new DOMException("Aborted", "AbortError");

/**
 * Stream one answer from the durable session.
 *
 * Creates the session on demand: a question typed while the model is merely
 * ON_DISK should just work, and the keystroke that submitted it is a perfectly
 * good user activation.
 */
export const streamAnswer = async ({ text, onChunk, signal }) => {
  if (!isReady()) {
    const { status, progressText } = getState();
    const meta = STATE_META[status];

    // A DOWNLOAD is not something to wait out behind a spinner. 2 GB on venue wifi
    // is legitimately many minutes, so queueing the question means typing dots with
    // no way to tell a slow model from a wedged one.
    //
    // This state is now AUTHORITATIVE, which it was not before. Under the Prompt API
    // `availability()` flapped between "available" and "downloading" while Chrome
    // worked, so this branch had to re-sample before refusing or it rejected every
    // question for minutes after the model had become usable. We own the download
    // now, so the state is a fact and the re-sample is gone.
    if (status === STATES.DOWNLOADING) {
      throw new Error(
        `The model is still downloading${progressText ? ` (${progressText})` : ""}. ` +
          "Ask again once it finishes.",
      );
    }

    // DOWNLOADABLE must NOT be treated as "just load it", even though its state
    // meta says the button would. A keystroke is a valid user activation, but this
    // particular action is a 2 GB fetch, and the composer is reachable long before a
    // presenter has looked at the header bar. Starting that silently, from typing,
    // is the single rudest thing this module could do.
    if (status === STATES.DOWNLOADABLE) {
      throw new Error(
        `The model isn't downloaded yet (${modelSize()}). Use the download button ` +
          "in the panel header when you're on a connection you trust.",
      );
    }

    // CREATING is different: it is seconds, and a question typed the moment the
    // deck loads is the normal case. `load()` hands back the in-flight attempt, so
    // this waits on that one rather than starting a second.
    const creating = status === STATES.CREATING;

    // Otherwise only try when the state says a click would have worked;
    // UNSUPPORTED and UNAVAILABLE must surface as themselves rather than as a
    // failure to load.
    if (!creating && meta?.action !== "load") {
      throw new Error(meta?.title ?? "The on-device model is not available");
    }

    // UNBOUNDED, deliberately. `load()` owns a ceiling on the only phase that can
    // hang -- the GPU load -- and refuses outright rather than waiting on a
    // download. A second bound here used to be SHORTER than the one inside
    // `model-state.js`, so it always fired first and the inner one could never
    // report; and any bound big enough for a first run would have to be minutes,
    // which is not a timeout, it is a hang with extra steps. What guarantees the UI
    // escapes a load that never settles is `use-conversation.js` `stop()`, which
    // clears `busy` without waiting for this to return.
    await load();

    // Re-read after the await: a download may have started underneath us, in which
    // case `error` is null and the generic message below would be wrong.
    const after = getState();
    if (!isReady()) {
      if (after.status === STATES.DOWNLOADING) {
        throw new Error(
          `The model is downloading${after.progressText ? ` (${after.progressText})` : ""}. ` +
            "Ask again once it finishes.",
        );
      }
      throw new Error(after.error ?? "Could not start a model session");
    }
  }

  if (signal?.aborted) throw aborted();

  const session = getSession();
  const guard = withIdleTimeout(signal);
  let accumulated = "";

  try {
    const stream = session.stream(answerTurn(text), {
      signal: guard.signal,
    });
    for await (const chunk of stream) {
      if (signal?.aborted) throw aborted();
      guard.arm();
      accumulated += chunk;
      onChunk?.(accumulated);
    }
    return accumulated;
  } catch (err) {
    // A user abort mid-stream is not an error to report; the caller keeps the
    // partial text.
    if (signal?.aborted || err.name === "AbortError") throw aborted();
    throw err;
  } finally {
    guard.stop();
    // The turn consumed context whether it finished, timed out, or was aborted
    // mid-answer, so the meter is refreshed on every exit path.
    touch();
  }
};
