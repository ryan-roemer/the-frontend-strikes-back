import { nextContext } from "./deck-context.js";
import {
  activeProvider,
  getSession,
  getState,
  isReady,
  load,
  modelSize,
  refresh,
  stateMeta,
  touch,
} from "./model-state.js";
import { STATES } from "./states.js";

/**
 * Talking to the durable session.
 *
 * STREAMING ONLY. Time-to-first-token is ~50ms warm but decode runs at ~65 tokens/sec, so
 * a non-streamed answer of any length reads as a hang.
 *
 * The provider yields deltas; this module accumulates and hands `onChunk` the accumulated
 * string, so the UI renders a self-contained value every time -- a dropped or reordered
 * chunk cannot desync the display, and partial markdown still renders.
 */

/** Long enough for a slow first token on a cold model, short enough that a
 *  wedged session doesn't look like a wedged deck. */
const TIMEOUT_MS = 45000;

/** Said in one place, because it is both the abort reason and what the user reads. */
const IDLE_MESSAGE = "The model stopped responding.";

/**
 * Reject if the model produces nothing for this long.
 *
 * A per-STREAM deadline would punish a long, healthy answer; this is an idle
 * timer, reset by every chunk, so it only fires when the model has actually
 * stopped talking.
 */
const withIdleTimeout = (signal) => {
  let timer = null;
  // A FLAG, NOT THE ABORT REASON. LiteRT converts any aborted-signal exit into its own
  // `DOMException(…, "AbortError")`, so downstream a timeout is indistinguishable from the
  // user pressing stop -- and the user's abort is deliberately silent. This flag stays on
  // our side of that boundary.
  let firedIdle = false;
  const controller = new AbortController();
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      firedIdle = true;
      controller.abort(new Error(IDLE_MESSAGE));
    }, TIMEOUT_MS);
  };
  const stop = () => clearTimeout(timer);
  signal?.addEventListener("abort", () => controller.abort(signal.reason));
  arm();
  return {
    signal: controller.signal,
    arm,
    stop,
    timedOut: () => firedIdle,
  };
};

const aborted = () => new DOMException("Aborted", "AbortError");

/**
 * Stream one answer from the durable session.
 *
 * Creates the session on demand: a question typed while the model is merely
 * ON_DISK should just work, and the keystroke that submitted it is a perfectly
 * good user activation.
 */
export const streamAnswer = async ({ text, onChunk, signal, onPrompt }) => {
  if (!isReady()) {
    // RE-SAMPLE BEFORE REFUSING, but only where the status is not a fact. On LiteRT a
    // DOWNLOADING reading is authoritative and a re-check is pure latency; under the Prompt
    // API `availability()` flaps, so a stale sample refuses questions for minutes after the
    // model has become usable.
    if (
      !activeProvider()?.capabilities.authoritativeStatus &&
      getState().status === STATES.DOWNLOADING
    ) {
      await refresh();
    }

    // Read AFTER the refresh, or the branches below act on the pre-refresh status.
    const { status, progressText } = getState();
    const meta = stateMeta(status);

    // A DOWNLOAD is not something to wait out behind a spinner: 2 GB on venue wifi is
    // many minutes of dots with no way to tell slow from wedged.
    if (status === STATES.DOWNLOADING) {
      throw new Error(
        `The model is still downloading${progressText ? ` (${progressText})` : ""}. ` +
          "Ask again once it finishes.",
      );
    }

    // DOWNLOADABLE must NOT be treated as "just load it", even though its state meta says
    // the button would: on LiteRT that action is a 2 GB fetch, and starting one silently
    // from a keystroke is not something typing should be able to do.
    if (status === STATES.DOWNLOADABLE) {
      const size = modelSize();
      throw new Error(
        `The model isn't downloaded yet${size ? ` (${size})` : ""}. Use the download ` +
          "button in the panel header when you're on a connection you trust.",
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

    // UNBOUNDED, deliberately. `load()` already bounds the only phase that can hang, and a
    // second bound here would either fire first and mask it, or have to be minutes long --
    // a hang with extra steps. What guarantees the UI escapes is `use-conversation.js`
    // `stop()`, which clears `busy` without waiting for this to return.
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

  const { pin, note, commit } = nextContext();

  try {
    // The question goes verbatim; deck context rides alongside it as separate arguments
    // and is never concatenated here. THE PLACEMENT BELONGS TO THE PROVIDER -- and folding
    // either into `text` would also put it in the transcript bubble, which renders `text`.
    //
    // `onPrompt` fires only from here down: every refusal above returned before the model
    // was reached, so those turns have no context to show and their bubbles get no button.
    const stream = session.stream(text, {
      pin,
      note,
      signal: guard.signal,
      onPrompt,
    });
    for await (const chunk of stream) {
      if (signal?.aborted) throw aborted();
      guard.arm();
      // The first token proves the prompt -- pin included -- was accepted, which is the
      // earliest point `deck-context.js` may record the slide as one the model holds. A
      // turn that dies before this line re-sends the slide next time.
      if (!accumulated) commit();
      accumulated += chunk;
      onChunk?.(accumulated);
    }
    return accumulated;
  } catch (err) {
    // CHECKED BEFORE THE ABORT CASE, because it looks exactly like one from here, and a
    // session that stopped producing tokens must not be swallowed as a user stop.
    if (guard.timedOut()) throw new Error(IDLE_MESSAGE);
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
