/* global LanguageModel:false, setInterval:false, clearInterval:false, console:false */
import { STATES } from "../states.js";

/**
 * The Chrome Prompt API: Gemini Nano, owned by the browser.
 *
 * The other half of the deck's story, and the more uncomfortable half. Everything LiteRT
 * gives the page -- the bytes, the progress, the cancel button, the delete button, a status
 * that is a fact -- belongs to Chrome here. What you get in exchange is real: no 2 GB
 * download to run, no WebGPU gate to pass, and a model that is already on disk for a large
 * number of people.
 *
 * ---------------------------------------------------------------------------
 * MEASURED 2026-08-12, Chrome 151.0.7922.76, and reproduced independently in a normal
 * Chrome profile with the Prompt API fully enabled:
 *
 *   - `LanguageModel.availability(...)` returned "downloading" INDEFINITELY -- for over
 *     ninety minutes, and for every configuration tried: no arguments, `{}`,
 *     `expectedInputs` alone, with and without `languages: ["en"]`, and `outputLanguage`.
 *     So it was not this file's `PROMPT_OPTIONS`.
 *   - `LanguageModel.create(...)` never resolved. A bare call with no arguments and none of
 *     this code in the stack hung past 30s, repeatedly.
 *   - It reported "available" twice and served one real answer early on, then went back to
 *     "downloading". The plumbing works; the platform is what is unreliable.
 *   - `params()` was absent entirely, which is why the info modal has no sampler rows.
 *
 * Every defensive thing in this file exists because of one of those observations: the
 * create ceiling, the availability poller, the `canDownload` arbiter, and
 * `authoritativeStatus: false`. None of it is speculative hardening.
 *
 * The single most important consequence is not in this file at all: because `create()` can
 * hang forever, `model-state.js` must be able to abandon a load that never settles, and the
 * switcher must stay clickable during CREATING so a presenter can fall back to LiteRT
 * mid-failure. See `pendingGeneration` there.
 * ---------------------------------------------------------------------------
 */

/**
 * Passed to BOTH `availability()` and `create()`.
 *
 * Availability is per-configuration: asking about the default configuration and then
 * creating a different one can report "available" and then fail. One object for both is
 * what makes the answer mean anything.
 */
const PROMPT_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

const supported = () => typeof LanguageModel !== "undefined";

/** Map Chrome's four availability strings onto the shared state set. */
const fromAvailability = (availability) =>
  availability === "available"
    ? STATES.ON_DISK
    : availability === "downloading"
      ? STATES.DOWNLOADING
      : availability === "downloadable"
        ? STATES.DOWNLOADABLE
        : STATES.UNAVAILABLE;

const availability = () =>
  LanguageModel.availability(PROMPT_OPTIONS).catch(() => null);

/**
 * Re-sample `availability()` while a download Chrome started is running.
 *
 * Chrome fires no event when a download it began finishes -- the `monitor` callback only
 * covers a download OUR `create()` triggered -- so polling is the only honest mechanism. It
 * runs only while DOWNLOADING and stops itself the moment that changes, so it costs nothing
 * in the normal case.
 */
const POLL_MS = 5000;

let poll = null;
let onPromoted = null;

const stopPoll = () => {
  clearInterval(poll);
  poll = null;
};

const startPoll = () => {
  if (poll || !supported()) return;
  poll = setInterval(async () => {
    if ((await availability()) === "available") {
      stopPoll();
      onPromoted?.();
    }
  }, POLL_MS);
};

/** The live session. Chrome's is durable and keeps its own history, unlike LiteRT's
 *  disposable conversations -- so there is nothing to rebuild per turn here. */
let session = null;

/** Wraps a Chrome `LanguageModel` session in the shared chat-handle contract. */
const wrap = (raw, system) => {
  /**
   * What this page has handed the session, kept only so `onPrompt` can report it.
   *
   * Chrome's history lives in the browser process and is not readable from here,
   * so unlike LiteRT this is a MIRROR rather than the source of truth. It is
   * accurate because it is written on the same code path that does the sending --
   * but it is a record of what went in, not a read of what the session holds, and
   * it is unbounded for the same reason Chrome's is.
   */
  let sent = [];

  return {
    /**
     * MUST STAY A GENERATOR.
     *
     * `promptStreaming` returns a ReadableStream, and Safari has no `Symbol.asyncIterator` on
     * those -- but `session.js` consumes this with `for await`. Chrome-only code that happens
     * to work is not the same as code that is correct, and this contract is shared.
     *
     * Yields DELTAS. Chrome already streams deltas, so unlike LiteRT there is nothing to
     * un-accumulate here.
     */
    async *stream(
      text,
      { pin = "", note = "", signal = null, onPrompt = null } = {},
    ) {
      // BOTH go inline, in front of the question, because there is nowhere else
      // for either: Chrome's session is durable and owns its own history, so there
      // is no preface to rebuild the way LiteRT does.
      //
      // For `pin` that is the one place Chrome's can't-un-send is an ADVANTAGE. The
      // slide needs to persist for the rest of the conversation, and here it does
      // so by itself -- no pinned region, no bookkeeping, no reset path to forget.
      // `deck-context.js` guarantees a slide is offered at most once, which is what
      // makes an unremovable send safe.
      //
      // For `note` it is a small, accepted loss. LiteRT drops the position line
      // after its turn; Chrome cannot, so a conversation that wanders the deck
      // accumulates ~20 tokens per move. Cheap, and the alternative -- not sending
      // it -- is a model that does not know the deck moved.
      const outgoing = [pin, note, text].filter(Boolean).join("\n\n");

      // Reported BEFORE the send, and from the mirror rather than from the session:
      // `sent` is what this page has put in, and the turn below is about to be added
      // to it. Copied, so a caller can hold it after later turns have appended.
      //
      // `message` is what actually goes to the model, block and all, rather than the
      // bare question -- the viewer's whole job is showing what was really sent, and
      // on this provider the block is part of the message. `pinned` is empty for the
      // same reason: there is no separate region here to show.
      onPrompt?.({
        provider: "chrome",
        system,
        pinned: [],
        history: sent.map((message) => ({ ...message })),
        message: outgoing,
        historyLimit: null,
      });

      let answer = "";
      const reader = raw.promptStreaming(outgoing, { signal }).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          // An empty yield would re-arm the idle timeout in `session.js` forever.
          if (value) {
            answer += value;
            yield value;
          }
        }
      } finally {
        reader.releaseLock?.();
        // Recorded even on abort, matching LiteRT: Chrome keeps a cancelled turn in
        // its own history, so a mirror that dropped it would drift from the session.
        // `outgoing`, not `text`: the block went to the session, so a mirror holding
        // the bare question would understate what the model is carrying.
        sent.push(
          { role: "user", content: outgoing },
          { role: "assistant", content: answer },
        );
      }
    },

    /**
     * Synchronous and exact, which is the one place Chrome is straightforwardly better.
     *
     * The session tracks its own occupancy, so there is a real number to read rather than
     * LiteRT's cached async sample. Measured on Chrome 151: 9 / 9216 on a fresh session with
     * a short system prompt, 24 after one turn.
     *
     * TWO SPELLINGS, and both are checked because the spec renamed them mid-flight.
     * `contextUsage`/`contextWindow` are what Chrome 151 actually ships; `inputUsage`/
     * `inputQuota` are the older names still in much of the published documentation. Reading
     * only the documented pair returned `undefined` here and silently hid the meter -- which
     * looked exactly like a provider that has no context to report, so it took a property
     * dump on a live session to notice.
     *
     * A non-finite or zero window reads as "no context" rather than as a percentage: a
     * percent of Infinity is NaN, which renders as a broken meter.
     */
    context() {
      const used = raw.contextUsage ?? raw.inputUsage;
      const total = raw.contextWindow ?? raw.inputQuota;
      if (typeof used !== "number" || typeof total !== "number") return null;
      if (!Number.isFinite(total) || total <= 0) return null;
      return { used, total, pct: Math.round((used / total) * 100) };
    },

    /** Nothing to sample: `context()` reads the session directly. */
    async sampleContext() {},

    /** `params()` was absent in Chrome 151, so there is nothing honest to report. */
    async benchmark() {
      return null;
    },

    /**
     * Empty the context window and keep talking.
     *
     * NOT `clone()`. Cloning copies the conversation history, which is precisely what the
     * broom exists to drop -- so it would leave the meter exactly where it was. A fresh
     * `create()` is the only real reset, and it is expensive, which is why
     * `capabilities.cheapRestart` is false and `model-state.js` routes this through a spinner.
     */
    async restart() {
      const next = await LanguageModel.create({
        ...PROMPT_OPTIONS,
        initialPrompts: [{ role: "system", content: system }],
      });
      try {
        raw.destroy();
      } catch {
        /* already gone */
      }
      raw = next;
      session = next;
      // The new session starts with an empty history, so the mirror must too.
      sent = [];
    },

    destroy() {
      try {
        raw.destroy();
      } catch (err) {
        console.warn("[chat] session.destroy() failed:", err.message);
      }
      if (session === raw) session = null;
    },
  };
};

export const provider = {
  id: "chrome",
  label: "Chrome",

  capabilities: {
    // The model is the browser's. We cannot watch it, stop it, or remove it.
    ownsBytes: false,
    canDelete: false,
    // Chrome does not say how big Gemini Nano is, and inventing a number to put in a
    // warning label would be worse than omitting the label.
    downloadBytes: null,
    // THE LOAD-BEARING ONE. `availability()` flaps between "available" and "downloading"
    // while Chrome works, so a DOWNLOADING reading is a sample, not a fact. `session.js`
    // re-checks before refusing a question on it -- without that, questions were rejected
    // for minutes after the model had become usable.
    authoritativeStatus: false,
    // A full `create()`, measured at ~9.5s when it worked at all.
    cheapRestart: false,
  },

  timings: {
    stallMs: 60000,
    // A BAIL-OUT, not a wedge detector -- the opposite of LiteRT's ceiling on the same
    // field. `create()` blocks for as long as Chrome is fetching the model, which measured
    // past 30s with no sign of finishing, so this bounds a phase that can legitimately take
    // minutes. Timing out lets the machine drop back to whatever `availability()` now says
    // instead of hanging on a condition that resolves itself.
    createCeilingMs: 90000,
  },

  stateMeta: {
    [STATES.UNSUPPORTED]: { title: "Prompt API not available in this browser" },
    [STATES.UNAVAILABLE]: {
      title: "Chrome can't run the built-in model on this device",
    },
    // No size in the label: we do not know it, and Chrome may also decline for reasons of
    // its own (disk, battery, metered connection).
    [STATES.DOWNLOADABLE]: {
      title: "Chrome hasn't downloaded its model — click to ask it to",
    },
    // Clickable, but only to LOOK AGAIN. The download is Chrome's, so there is nothing to
    // cancel -- and a re-check is the one genuinely useful thing here, because Chrome
    // reports no completion event for a download it started itself.
    [STATES.DOWNLOADING]: {
      title: "Chrome is downloading its model… (click to re-check)",
      action: "recheck",
    },
    [STATES.CREATING]: { title: "Starting a session…" },
    [STATES.READY]: { title: "Session live — click to free it" },
  },

  /** Only when the global exists. A pill for an API this browser has never heard of is
   *  noise; the absent entry is itself the honest report. */
  offered: supported,

  /** No GPU gate. Where the model runs is Chrome's business, not ours -- which is exactly
   *  the trade this provider represents. */
  async probe() {
    return supported()
      ? { ok: true, supported: true, reason: null }
      : {
          ok: false,
          supported: false,
          reason: "This browser has no Prompt API.",
        };
  },

  async status() {
    if (!supported()) return STATES.UNSUPPORTED;
    const now = await availability();
    if (now === null) return STATES.ERROR;
    const status = fromAvailability(now);
    if (status === STATES.DOWNLOADING) startPoll();
    else stopPoll();
    return status;
  },

  /**
   * Create the durable session.
   *
   * `signal` is accepted and ignored: `create()` takes no AbortSignal, so there is nothing
   * to pass it to. The escape hatch is the ceiling in `model-state.js` plus a provider
   * switch, not cancellation.
   */
  async acquire({ system, onPhase }) {
    // Whether a download is even possible decides how to read the monitor below. Asking
    // first is cheap and turns a guess into a fact.
    const before = await availability();
    const canDownload = before === "downloadable" || before === "downloading";

    const created = await LanguageModel.create({
      ...PROMPT_OPTIONS,
      initialPrompts: [{ role: "system", content: system }],
      monitor: (monitor) => {
        monitor.addEventListener("downloadprogress", (event) => {
          // Chrome fires this even when nothing is being fetched -- an already-available
          // model reports `loaded: 0` once and then simply finishes creating. Trusting the
          // event alone produced a permanent "Downloading… (0%)" on a model that was fully
          // on disk, so the pre-create availability is the arbiter of what it means.
          if (!canDownload) return;
          onPhase?.({
            phase: "download",
            progress: event.loaded,
            // No byte counts: Chrome reports a fraction and never a total, and inventing
            // "? / ? MB" says less than nothing.
            text: null,
          });
          startPoll();
        });
      },
    });

    onPhase?.({ phase: "engine", text: "Starting a session…", progress: null });
    stopPoll();
    session = created;
    return wrap(created, system);
  },

  /** Same as evict: there is only the session, and Chrome keeps nothing else for us. */
  release: () => {
    stopPoll();
  },

  evict: async () => {
    stopPoll();
    if (session) {
      try {
        session.destroy();
      } catch {
        /* already gone */
      }
      session = null;
    }
  },

  resident: () => Boolean(session),

  async info() {
    const now = await availability();
    return [
      ["Model", "Gemini Nano (Chrome built-in)"],
      ["Runtime", "Chrome Prompt API · window.LanguageModel"],
      ["Availability", now ?? "availability() threw"],
      ["Session", session ? "live" : "none"],
      // `LanguageModel.params()` is absent on Chrome 151 -- verified by property dump, not
      // assumed -- so there are no defaultTopK / maxTemperature rows to show. Saying why
      // beats leaving a gap where a reader expects numbers.
      [
        "Sampler params",
        typeof LanguageModel.params === "function"
          ? "available"
          : "not exposed by this Chrome build",
      ],
      // The page cannot see, watch, or bound this. That absence IS the comparison the deck
      // is making, so it gets a row rather than being quietly omitted.
      ["Download", "managed by Chrome — not visible to this page"],
    ];
  },

  /** The page cannot delete Chrome's model, so the modal shows this instead of a button. */
  manageNote: {
    text: "Chrome owns this model, so this page can't download or delete it. Manage it at",
    url: "chrome://on-device-internals",
  },

  unavailableCopy: (status) =>
    status === STATES.UNSUPPORTED
      ? {
          lead: "This browser doesn't expose the Prompt API, so there is no built-in model to talk to.",
          bullets: [
            "It ships in Chrome 138+ on desktop, and only on supported hardware.",
            "Some builds still need the flag at chrome://flags/#prompt-api-for-gemini-nano.",
            "Switch to the Gemma provider to run a model this page downloads itself.",
          ],
        }
      : {
          lead: "Chrome has the Prompt API but won't provide a model on this device.",
          bullets: [
            "Chrome declines on low disk space, on metered connections, and on unsupported GPUs.",
            "chrome://on-device-internals shows what it decided and why.",
            "Switch to the Gemma provider to run a model this page downloads itself.",
          ],
        },

  /** Let `model-state.js` hear about a background download finishing. */
  onPromoted(fn) {
    onPromoted = fn;
  },
};
