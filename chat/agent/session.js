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
  // WHY A FLAG AND NOT THE ABORT REASON. Both providers abort through the same
  // controller, and only one of them preserves the reason: LiteRT converts any
  // aborted-signal exit into its own `DOMException(…, "AbortError")`, so by the time
  // the catch below sees it, a timeout is indistinguishable from the user pressing
  // stop -- and the user's abort is deliberately silent. The result was a wedged
  // LiteRT session reporting nothing at all, while the identical timeout on Chrome
  // said "The model stopped responding". This flag is on our side of that boundary.
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
    // RE-SAMPLE BEFORE REFUSING, but only where the status is not a fact.
    //
    // On LiteRT we own the download, so a DOWNLOADING reading is authoritative and a
    // re-check would be pure latency. Under the Prompt API `availability()` FLAPS between
    // "available" and "downloading" while Chrome works, so a stale sample refused every
    // question for minutes after the model had become usable. One fresh check is cheap and
    // it is the only thing standing between a working model and a panel that says no.
    if (
      !activeProvider()?.capabilities.authoritativeStatus &&
      getState().status === STATES.DOWNLOADING
    ) {
      await refresh();
    }

    // Read AFTER the refresh. Reading these before it is what made an earlier version of
    // this fix do nothing: the refreshed status said ON_DISK while the captured one still
    // said DOWNLOADING, and the captured one is what the branches used.
    const { status, progressText } = getState();
    const meta = stateMeta(status);

    // A DOWNLOAD is not something to wait out behind a spinner. 2 GB on venue wifi is
    // legitimately many minutes, so queueing the question means typing dots with no way to
    // tell a slow model from a wedged one.
    if (status === STATES.DOWNLOADING) {
      throw new Error(
        `The model is still downloading${progressText ? ` (${progressText})` : ""}. ` +
          "Ask again once it finishes.",
      );
    }

    // DOWNLOADABLE must NOT be treated as "just load it", even though its state meta says
    // the button would. A keystroke is a valid user activation, but on LiteRT this action
    // is a 2 GB fetch, and the composer is reachable long before a presenter has looked at
    // the header bar. Starting that silently, from typing, is the single rudest thing this
    // module could do.
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

  const { pin, note, commit } = nextContext();

  try {
    // The question goes verbatim; deck context rides alongside it, never
    // concatenated here.
    //
    // THE PLACEMENT BELONGS TO THE PROVIDER, which is the whole reason these are
    // separate arguments. The two providers put `pin` in different structures --
    // LiteRT in a region of the preface it rebuilds every turn, Chrome inline in
    // the sent string because its session is durable and there is nowhere else --
    // and neither placement is the caller's business. Folding either into `text`
    // here would also put it in the transcript bubble, which renders `text`.
    //
    // READ AT SEND TIME, deliberately: a slide the presenter walked past without
    // asking about never enters the model's context at all.
    //
    // There used to be an `answerTurn()` wrapper here attaching retrieved excerpts
    // per turn, with a `remember` option so only the bare question was kept. Those
    // excerpts accumulated and degraded answers into "please provide the context"
    // by the third question. `deck-context.js` is the opposite bargain for `pin`:
    // each slide is sent once and kept, rather than re-sent every turn and dropped.
    //
    // `onPrompt` fires only from here down, which is deliberate: every refusal
    // above this line returned before the model was reached, so those turns have
    // no context to show and their bubbles get no button.
    const stream = session.stream(text, {
      pin,
      note,
      signal: guard.signal,
      onPrompt,
    });
    for await (const chunk of stream) {
      if (signal?.aborted) throw aborted();
      guard.arm();
      // The first token is the proof that the prompt -- pin included -- was
      // accepted, which is the earliest point at which `deck-context.js` may
      // record the slide as one the model holds. A turn that dies before this
      // line simply re-sends the slide next time.
      if (!accumulated) commit();
      accumulated += chunk;
      onChunk?.(accumulated);
    }
    return accumulated;
  } catch (err) {
    // CHECKED BEFORE THE ABORT CASE, because it looks exactly like one from here.
    // A session that stopped producing tokens is the failure a presenter most needs
    // told about, and it must not be swallowed as though they had pressed stop.
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
