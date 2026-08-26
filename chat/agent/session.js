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
  subscribe,
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
 * Say that a download started, and keep saying how it is going, in the answer bubble.
 *
 * WHAT MAKES AUTOLOADING HONEST. A question that silently begins a 2 GB fetch is a
 * question that took a decision the person did not know they were making; a question that
 * says "Downloading Gemma 4 E2B (2 GB)… 34%" and can be stopped is one that told them.
 * The size comes from `modelSize()`, so a provider whose bytes are not ours -- Chrome --
 * omits it rather than inventing one.
 *
 * IT WRITES WHERE THE ANSWER WILL BE, but NOT DOWN THE ANSWER'S CHANNEL. `onStatus` is a
 * separate callback that the caller renders the same way, and the separation is
 * load-bearing rather than tidy: `act/respond.js` decides from the FIRST chunk of an
 * answer whether the reply is prose or a tool call and never revisits it, so a status line
 * arriving on `onChunk` would be sniffed as prose and pin the whole turn -- a tool call
 * would then stream its raw fence into the transcript instead of running.
 *
 * The caller paints it where the answer will go, so the first real token overwrites all of
 * this. There is nothing to tear down and no way for a status line to survive into the
 * transcript, including when the load throws.
 *
 * SUBSCRIBES RATHER THAN POLLS. `model-state.js` publishes on every progress event
 * already, and a timer would repaint a frozen number on Chrome -- whose "downloading" is
 * a report rather than a measurement -- making a stalled fetch look busy.
 */
const announce = (onStatus) => {
  if (!onStatus) return () => {};

  const size = modelSize();
  const lead = `Downloading the model${size ? ` (${size})` : ""}`;
  let done = false;

  const paint = () => {
    if (done) return;
    const { progressText } = getState();
    onStatus(`${lead}…${progressText ? ` ${progressText}` : ""}`);
  };

  paint();
  const off = subscribe(paint);

  return () => {
    done = true;
    off();
  };
};

/**
 * Stream one answer from the durable session.
 *
 * Creates the session on demand: a question typed while the model is merely
 * ON_DISK should just work, and the keystroke that submitted it is a perfectly
 * good user activation.
 */
export const streamAnswer = async ({
  text,
  onChunk,
  onStatus,
  signal,
  onPrompt,
}) => {
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

    // DOWNLOADABLE LOADS, and this used to refuse. The old reasoning was that on LiteRT
    // the action is a 2 GB fetch and "starting one silently from a keystroke is not
    // something typing should be able to do" -- but the refusal it produced sent someone
    // who had just asked a question to hunt for a button in the panel header, which is a
    // worse first experience than the download it was protecting them from. Asking IS the
    // intent to use the model.
    //
    // NOT SILENT, which is what makes it safe rather than merely convenient: `announce`
    // below puts the size and live progress in the answer bubble, the header shows its own
    // meter, and stop works throughout. The cost is stated before it is paid, and it is
    // interruptible while it is being paid.
    //
    // CREATING falls through here too. It is seconds, and a question typed the moment the
    // deck loads is the normal case; `load()` hands back the in-flight attempt, so this
    // waits on that one rather than building a second.
    const creating = status === STATES.CREATING;

    // Otherwise only try when the state says a click would have worked;
    // UNSUPPORTED and UNAVAILABLE must surface as themselves rather than as a
    // failure to load.
    if (
      !creating &&
      status !== STATES.DOWNLOADABLE &&
      meta?.action !== "load"
    ) {
      throw new Error(meta?.title ?? "The on-device model is not available");
    }

    // Progress into the bubble, for as long as the load runs. A 2 GB wait belongs where
    // the person is already looking, not only in a header meter above a panel they may
    // have scrolled. `onStatus`, never `onChunk` -- see `announce`.
    const stopAnnouncing =
      status === STATES.DOWNLOADABLE ? announce(onStatus) : () => {};
    // UNBOUNDED, deliberately. `load()` already bounds the only phase that can hang, and a
    // second bound here would either fire first and mask it, or have to be minutes long --
    // a hang with extra steps. What guarantees the UI escapes is `use-conversation.js`
    // `stop()`, which clears `busy` without waiting for this to return.
    try {
      await load();
    } finally {
      stopAnnouncing();
    }

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
