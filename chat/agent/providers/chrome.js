import { STATES } from "../states.js";

/**
 * The Chrome Prompt API: Gemini Nano, owned by the browser.
 *
 * Everything LiteRT gives the page -- the bytes, the progress, a cancel, a delete, a status
 * that is a fact -- belongs to Chrome here. In exchange there is no 2 GB download and no
 * WebGPU gate.
 *
 * THE API IS NOT RELIABLE, measured on Chrome 151 in a normal profile with the Prompt API
 * fully enabled. `availability()` returned "downloading" for over ninety minutes across
 * every configuration tried; `create()` hung past 30s repeatedly, including a bare call
 * with none of this code in the stack; it reported "available" and served a real answer
 * before going back to "downloading". `params()` was absent entirely, which is why the info
 * modal has no sampler rows.
 *
 * The create ceiling, the availability poller, the `canDownload` arbiter and
 * `authoritativeStatus: false` all exist because of that, and none of it is speculative.
 * The most important consequence is not in this file: because `create()` can hang forever,
 * `model-state.js` must be able to abandon a load that never settles, and the provider
 * switcher must stay clickable during CREATING.
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
   * A MIRROR, not the source of truth: Chrome's history lives in the browser process and
   * cannot be read from here. Unbounded, for the same reason Chrome's is.
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
      // BOTH GO INLINE, because Chrome's session is durable and owns its own history --
      // there is no preface to rebuild the way LiteRT does.
      //
      // For `pin` that makes Chrome's can't-un-send an advantage: the slide persists for
      // the rest of the conversation by itself, and `deck-context.js` offering each slide
      // at most once is what makes an unremovable send safe.
      //
      // For `note` it is an accepted loss. LiteRT drops the position line after its turn;
      // Chrome cannot, so wandering the deck accumulates ~20 tokens per move. The
      // alternative is a model that does not know the deck moved.
      const outgoing = [pin, note, text].filter(Boolean).join("\n\n");

      // `message` is what actually goes to the model, block and all: on this provider the
      // block IS part of the message, which is also why `pinned` is empty. Copied, so a
      // caller can hold it after later turns have appended.
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
        // CANCEL, THEN RELEASE. Breaking out of the `for await` in `session.js` abandons
        // this generator without the outer signal necessarily firing, and releasing the
        // lock alone leaves the underlying stream open and producing.
        await reader.cancel().catch(() => {});
        reader.releaseLock?.();
        // Recorded even on abort: Chrome keeps a cancelled turn in its own history, so a
        // mirror that dropped it would drift. `outgoing`, not `text` -- the block went to
        // the session, so recording the bare question understates what the model holds.
        sent.push(
          { role: "user", content: outgoing },
          { role: "assistant", content: answer },
        );
      }
    },

    /**
     * Synchronous and exact -- the session tracks its own occupancy, so there is a real
     * number to read rather than LiteRT's cached async sample.
     *
     * TWO SPELLINGS, both checked because the spec renamed them mid-flight.
     * `contextUsage`/`contextWindow` are what Chrome 151 ships; `inputUsage`/`inputQuota`
     * are the older names still in most published documentation. Reading only the
     * documented pair returns `undefined` and silently hides the meter.
     *
     * A non-finite or zero window reads as "no context": a percent of Infinity is NaN.
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
     * NOT `clone()`: cloning copies the history, which is exactly what the broom drops, so
     * the meter would not move. A fresh `create()` is the only real reset, and it is
     * expensive -- hence `cheapRestart: false` and the spinner.
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
    // THE LOAD-BEARING ONE. `availability()` flaps between "available" and "downloading",
    // so a DOWNLOADING reading is a sample rather than a fact, and `session.js` re-checks
    // before refusing a question on it.
    authoritativeStatus: false,
    // A full `create()`, measured at ~9.5s when it worked at all.
    cheapRestart: false,
  },

  timings: {
    stallMs: 60000,
    // A BAIL-OUT, not a wedge detector -- the opposite of LiteRT's ceiling on the same
    // field. `create()` blocks for as long as Chrome is fetching, so timing out lets the
    // machine drop back to whatever `availability()` now says.
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
   * NO `signal`, unlike LiteRT's `acquire`: `LanguageModel.create()` takes no AbortSignal,
   * so it is left out of the signature rather than accepted and dropped. The escape hatch
   * is the ceiling in `model-state.js` plus a provider switch, not cancellation.
   */
  async acquire({ system, onPhase }) {
    // Whether a download is even possible decides how to read the monitor below.
    const before = await availability();
    const canDownload = before === "downloadable" || before === "downloading";

    const created = await LanguageModel.create({
      ...PROMPT_OPTIONS,
      initialPrompts: [{ role: "system", content: system }],
      monitor: (monitor) => {
        monitor.addEventListener("downloadprogress", (event) => {
          // Chrome fires this even when nothing is being fetched: an already-available
          // model reports `loaded: 0` once and then finishes creating. Trusting the event
          // alone shows a permanent "Downloading… (0%)" over a model that is on disk, so
          // the pre-create availability is the arbiter.
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

  /**
   * Stop watching, keep the session. NOT the same as `evict`, which also destroys it:
   * `unload()` calls this after destroying the conversation itself, so destroying `session`
   * here too would be a double teardown of a handle the machine has already disowned.
   */
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
      // `params()` is absent on Chrome 151, so there are no defaultTopK / maxTemperature
      // rows. Saying why beats leaving a gap where a reader expects numbers.
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
