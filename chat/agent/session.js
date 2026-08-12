/* global AbortController:false, DOMException:false, setTimeout:false, clearTimeout:false */
import {
  getSession,
  getState,
  isReady,
  load,
  refresh,
  STATE_META,
  STATES,
  touch,
} from "./model-state.js";
import { answerTurn } from "./prompt.js";

/**
 * Talking to the durable session.
 *
 * Streaming only. `promptStreaming` is what makes an on-device model feel usable:
 * Gemma Nano's time-to-first-token is short but its throughput is not, so a
 * non-streamed answer reads as a hang.
 *
 * Chunks are handed on ACCUMULATED rather than as deltas. Both reference repos do
 * this, and the reason is worth keeping: the UI then renders a self-contained
 * string every time, so a dropped or reordered chunk cannot desync the display,
 * and partial markdown still renders.
 *
 * TODO(PROMPT): unverified end to end against a real model beyond one early answer.
 * `LanguageModel.create()` currently hangs on this platform under every
 * configuration -- see the block comment in `model-state.js`. This module's shape
 * (streamed, abortable, idle-timed) is what a LiteRT.js provider should also
 * present; see `docs/chat-handoff.md`.
 */

/** Long enough for a slow first token on a cold model, short enough that a
 *  wedged session doesn't look like a wedged deck. */
const TIMEOUT_MS = 45000;

/** Ceiling on session creation. Measured at ~9.5s on a warm model, so this is
 *  generous -- it exists to catch a `create()` that is secretly waiting on a
 *  download rather than to bound the normal path. */
const CREATE_TIMEOUT_MS = 60000;

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
    // A DOWNLOAD is not something to wait out behind a spinner.
    //
    // Measured: with Chrome mid-download, `availability()` sits on "downloading"
    // and a bare `LanguageModel.create()` -- no code of ours involved -- had not
    // resolved after 30s. A multi-gigabyte fetch can take many minutes, so
    // queueing the question means typing dots forever and no way to tell a slow
    // model from a wedged one.
    //
    // But re-sample BEFORE refusing. `availability()` flaps between "available"
    // and "downloading" while Chrome works, so a DOWNLOADING on record may just be
    // a stale sample -- refusing on it rejected every question for minutes after
    // the model had become usable. One fresh check is cheap.
    if (getState().status === STATES.DOWNLOADING) await refresh();

    // Re-read AFTER the refresh. Reading these before it is what made the fix
    // above do nothing: the refreshed status said ON_DISK while the captured one
    // still said DOWNLOADING, and the captured one is what the branches used.
    const { status } = getState();
    const meta = STATE_META[status];

    if (status === STATES.DOWNLOADING) {
      const { progress } = getState();
      const pct = progress != null ? ` (${Math.round(progress * 100)}%)` : "";
      throw new Error(
        `The on-device model is still downloading${pct}. Ask again once it finishes.`,
      );
    }

    // CREATING is different: it is seconds, and a question typed the moment the
    // deck loads is the normal case. `load()` hands back the in-flight attempt,
    // so this waits on that one rather than starting a second.
    const creating = status === STATES.CREATING;

    // Otherwise only try when the state says a click would have worked;
    // UNSUPPORTED and UNAVAILABLE must surface as themselves rather than as a
    // failure to load.
    if (!creating && meta?.action !== "load") {
      throw new Error(meta?.title ?? "The on-device model is not available");
    }

    // Bounded, because `create()` can itself block on a download that started
    // after we checked.
    await Promise.race([
      load(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The model took too long to start")),
          CREATE_TIMEOUT_MS,
        ),
      ),
    ]);
    if (!isReady()) {
      throw new Error(getState().error ?? "Could not start a model session");
    }
  }

  if (signal?.aborted) throw aborted();

  const session = getSession();
  const guard = withIdleTimeout(signal);
  let accumulated = "";

  try {
    const stream = session.promptStreaming(answerTurn(text), {
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
