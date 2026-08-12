/* global LanguageModel:false, console:false, setTimeout:false, setInterval:false, clearInterval:false */

/**
 * Where the on-device model is, as one small state machine.
 *
 * Shaped after joyce's `LoadingButton`: a states table, an icon per state, and a
 * primary action whose MEANING changes with the state. The important difference
 * is what the actions can actually do. joyce gates unload and delete-from-disk
 * behind `providerManagesMemory()` and deliberately excludes Chrome built-in AI
 * -- "the model is the OS's, not held in a page-owned engine" -- and its
 * `unloadLlmEngine` for that provider is a documented no-op.
 *
 * So the two affordances are remapped onto what a page genuinely controls:
 *
 *   joyce                     here
 *   ------------------------  ----------------------------------------------
 *   cached (bytes on disk)    ON_DISK, verbatim: available, no session
 *   loaded -> unload memory   READY -> destroy() the session, freeing it and
 *                             its accumulated context
 *   delete from disk          NOT POSSIBLE from a page. Surfaced in the info
 *                             modal as chrome://on-device-internals instead.
 *
 * The machine is a module singleton rather than React state because the session
 * must outlive the panel being closed, and because `plan.js` needs it without
 * being a component.
 *
 * ---------------------------------------------------------------------------
 * TODO(PROMPT): the Chrome Prompt API does not currently work on this machine, and
 * the failure is the platform's, not this code's. Measured 2026-08-12, Chrome
 * 151.0.7922.76, and reproduced independently by the deck's author in a normal
 * Chrome profile with the Prompt API fully enabled:
 *
 *   - `LanguageModel.availability(...)` returns "downloading" indefinitely -- for
 *     over ninety minutes, and for EVERY configuration tried: no arguments at all,
 *     `{}`, `expectedInputs` alone, with and without `languages: ["en"]`, and
 *     `outputLanguage`. So it is not this file's `PROMPT_OPTIONS`.
 *   - `LanguageModel.create(...)` never resolves. A bare call with no arguments and
 *     none of this code in the stack hung past 30s, repeatedly.
 *   - It briefly reported "available" twice and even served one real answer early
 *     on ("A browser is a software application that allows you to access and view
 *     websites on the internet"), then went back to "downloading". So the plumbing
 *     here is known to work; the platform is what is unreliable.
 *   - `chrome://on-device-internals` would say more, but it is gated behind the
 *     debug-WebUI flag at `chrome://chrome-urls`.
 *
 * Everything downstream of this file is provider-shaped on purpose and does not
 * care where tokens come from -- see `docs/chat-handoff.md` for the LiteRT.js /
 * Gemma swap this was left ready for. What the API's flakiness DID buy: the
 * download-vs-creating split, the create ceiling, the flap re-sampling, and the
 * abort plumbing all exist because of failures observed here.
 * ---------------------------------------------------------------------------
 */

/**
 * Passed to BOTH `availability()` and `create()`.
 *
 * Availability is per-configuration: asking about the default configuration and
 * then creating a different one can report "available" and then fail. Keeping one
 * object for both is what makes the answer mean anything.
 */
const PROMPT_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

export const STATES = {
  UNSUPPORTED: "unsupported",
  UNAVAILABLE: "unavailable",
  DOWNLOADABLE: "downloadable",
  DOWNLOADING: "downloading",
  ON_DISK: "on-disk",
  CREATING: "creating",
  READY: "ready",
  ERROR: "error",
};

/** Presentation for each state: Phosphor icon, label, and what a click does. */
export const STATE_META = {
  [STATES.UNSUPPORTED]: {
    icon: "ph-prohibit",
    tone: "off",
    title: "Prompt API not available in this browser",
    action: null,
  },
  [STATES.UNAVAILABLE]: {
    icon: "ph-warning-circle",
    tone: "warn",
    title: "This device can't run the on-device model",
    action: null,
  },
  [STATES.DOWNLOADABLE]: {
    icon: "ph-download-simple",
    tone: "idle",
    title: "Model not downloaded — click to download",
    action: "load",
  },
  [STATES.DOWNLOADING]: {
    icon: "ph-arrows-clockwise",
    tone: "busy",
    title: "Downloading the on-device model… (click to re-check)",
    // Clickable, unlike the other busy state. The download is Chrome's, not ours,
    // so there is no event telling us it finished -- a manual re-check is the one
    // thing a presenter can usefully do here.
    action: "recheck",
  },
  [STATES.ON_DISK]: {
    icon: "ph-database",
    tone: "idle",
    title: "On disk, not loaded — click to start a session",
    action: "load",
  },
  // Distinct from DOWNLOADING, because conflating them tells a lie that shows.
  // `create()` on an already-downloaded model still takes seconds, and Chrome
  // fires a `downloadprogress` event with `loaded: 0` on that path too -- so the
  // first cut of this file sat on "Downloading the on-device model... (0%)" while
  // `availability()` cheerfully reported "available". Same spinner, true label.
  [STATES.CREATING]: {
    icon: "ph-arrows-clockwise",
    tone: "busy",
    title: "Starting a session…",
    action: null,
  },
  [STATES.READY]: {
    icon: "ph-check-circle",
    tone: "ok",
    title: "Session live — click to unload it",
    action: "unload",
  },
  [STATES.ERROR]: {
    icon: "ph-warning-circle",
    tone: "error",
    title: "Failed — click to retry",
    action: "load",
  },
};

let state = {
  status: STATES.UNSUPPORTED,
  /** 0..1 while downloading, else null. */
  progress: null,
  /** ms the last create() took, for the label -- joyce shows this too. */
  elapsed: null,
  error: null,
  /** Raw `availability()` string, shown in the info modal. */
  availability: null,
  /** Bumped whenever the live session changes, so context readouts refresh. */
  revision: 0,
};

/** The durable chat session. Not in `state`: it is not renderable, and putting a
 *  live object in a snapshot invites components to hold stale references. */
let session = null;

const listeners = new Set();

const set = (patch) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
};

export const getState = () => state;
export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getSession = () => session;
export const isReady = () => state.status === STATES.READY && !!session;

const supported = () => typeof LanguageModel !== "undefined";

/**
 * Re-sample `availability()` while a download is in progress.
 *
 * `availability()` FLAPS. Measured over several minutes of Chrome fetching Gemma:
 * it returned "available" while `create()` still hung past 25s, then "downloading"
 * again, repeatedly, before settling. A single sample taken at mount is therefore
 * not a fact about the model, it is a fact about one instant -- and the machine used
 * to keep that instant forever, refusing every question until the panel was closed
 * and reopened.
 *
 * Chrome fires no event when a download it started finishes (the `monitor` callback
 * only covers a download OUR `create()` triggered), so polling is the only honest
 * mechanism. It runs only while DOWNLOADING and stops itself the moment that
 * changes, so it costs nothing in the normal case.
 */
const POLL_MS = 5000;

let downloadPoll = null;

const stopDownloadPoll = () => {
  if (!downloadPoll) return;
  clearInterval(downloadPoll);
  downloadPoll = null;
};

const startDownloadPoll = () => {
  if (downloadPoll || !supported()) return;
  downloadPoll = setInterval(async () => {
    if (state.status !== STATES.DOWNLOADING || session) {
      stopDownloadPoll();
      return;
    }
    const now = await LanguageModel.availability(PROMPT_OPTIONS).catch(
      () => null,
    );
    if (now === "available") {
      stopDownloadPoll();
      set({ status: STATES.ON_DISK, availability: now, error: null });
    }
  }, POLL_MS);
};

/**
 * Ask the platform where things stand, without creating anything.
 *
 * Never promotes to READY: a live session is a thing we hold, not a thing to
 * discover, so an existing session short-circuits and everything else lands on
 * the availability answer.
 */
export const refresh = async () => {
  if (!supported()) {
    set({ status: STATES.UNSUPPORTED, availability: null });
    return state;
  }
  if (session) {
    set({ status: STATES.READY });
    return state;
  }
  // A create in flight already owns the status (CREATING / DOWNLOADING). The
  // panel calls this every time it opens, and overwriting a live spinner with an
  // availability answer would drop the row back to "click to start" while the
  // session it would start is already being built.
  if (pendingLoad) return state;
  try {
    const availability = await LanguageModel.availability(PROMPT_OPTIONS);
    const status =
      availability === "available"
        ? STATES.ON_DISK
        : availability === "downloading"
          ? STATES.DOWNLOADING
          : availability === "downloadable"
            ? STATES.DOWNLOADABLE
            : STATES.UNAVAILABLE;
    set({ status, availability, error: null });
    if (status === STATES.DOWNLOADING) startDownloadPoll();
    else stopDownloadPoll();
  } catch (err) {
    set({ status: STATES.ERROR, error: err.message });
  }
  return state;
};

/**
 * The system prompt, supplied by the caller.
 *
 * A function rather than a string because the deck knowledge it embeds is
 * harvested from the live DOM, so it cannot be built at import time. Set by
 * `chat/index.js` at mount.
 */
let systemPromptFn = () =>
  "You are a helpful assistant embedded in a slide deck.";

export const setSystemPrompt = (fn) => {
  systemPromptFn = fn;
};

/** In-flight `createSession()`, so concurrent callers share one attempt. */
let pendingLoad = null;

/**
 * Create the durable session.
 *
 * Only called from a click, or from the preload when the model is already
 * ON_DISK. Never speculatively on a DOWNLOADABLE model: that download is
 * multi-gigabyte and requires transient user activation, so firing it on page
 * load would both fail and be rude. When it does run from a click, the click IS
 * the activation.
 */
export const load = async () => {
  if (!supported()) {
    set({ status: STATES.UNSUPPORTED });
    return null;
  }
  if (session) return session;

  // Creating takes seconds, which is plenty of time for a second click, a
  // `warmUp()` and a submitted question to all ask for a session. Handing back
  // the in-flight promise means they wait on the same one instead of racing to
  // create three and leaking two.
  if (pendingLoad) return pendingLoad;

  pendingLoad = createSession();
  try {
    return await pendingLoad;
  } finally {
    pendingLoad = null;
  }
};

/**
 * Ceiling on a single `create()`.
 *
 * Not a nicety. `create()` blocks for as long as Chrome is fetching the model, and
 * measured here that outlasted 30s with no sign of finishing. Without a bound the
 * `pendingLoad` promise never settles, `refresh()` returns early forever because a
 * load is "in flight", and the row is stuck on a spinner with no way back -- the
 * state machine wedges permanently on a condition that resolves itself in minutes.
 * Timing out lets the machine drop back to whatever `availability()` now says.
 */
const CREATE_CEILING_MS = 90000;

const createSession = async () => {
  const startedAt = Date.now();

  // Whether a download is even possible decides how to read the monitor below.
  // Asking first is cheap and turns a guess into a fact.
  const before = await LanguageModel.availability(PROMPT_OPTIONS).catch(
    () => null,
  );
  const canDownload = before === "downloadable" || before === "downloading";

  set({
    status: STATES.CREATING,
    error: null,
    progress: null,
    availability: before,
  });

  try {
    const created = await Promise.race([
      LanguageModel.create({
        ...PROMPT_OPTIONS,
        initialPrompts: [{ role: "system", content: systemPromptFn() }],
        monitor: (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            // Chrome fires this even when nothing is being fetched -- an
            // already-available model reports `loaded: 0` once and then simply
            // finishes creating. Trusting the event alone is what produced a
            // permanent "Downloading... (0%)" on a model that was fully on disk,
            // so the pre-create availability is the arbiter of what this means.
            if (!canDownload) return;
            set({ status: STATES.DOWNLOADING, progress: event.loaded });
            startDownloadPoll();
          });
        },
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Session creation timed out")),
          CREATE_CEILING_MS,
        ),
      ),
    ]);

    session = created;
    stopDownloadPoll();
    set({
      status: STATES.READY,
      progress: null,
      elapsed: Date.now() - startedAt,
      availability: "available",
      revision: state.revision + 1,
    });
    return session;
  } catch (err) {
    // A download refused for want of a gesture is not a failure state -- the
    // model is still perfectly downloadable, we just asked at the wrong moment.
    // Reporting ERROR here would put a red icon on a deck that only needs a
    // click, which on stage is a materially worse lie than the truth.
    const needsActivation =
      err.name === "NotAllowedError" || /activation|gesture/i.test(err.message);

    // A timeout says nothing about the model, only that we stopped waiting -- so
    // ask the platform where things stand instead of guessing. Usually this is a
    // download that started underneath us, and "downloading" is the honest answer.
    let status = needsActivation ? STATES.DOWNLOADABLE : STATES.ERROR;
    if (/timed out/i.test(err.message)) {
      const now = await LanguageModel.availability(PROMPT_OPTIONS).catch(
        () => null,
      );
      status =
        now === "downloading" || now === "downloadable"
          ? STATES.DOWNLOADING
          : now === "available"
            ? STATES.ON_DISK
            : STATES.ERROR;
    }

    set({
      status,
      progress: null,
      error: err.message,
      revision: state.revision + 1,
    });
    if (status === STATES.DOWNLOADING) startDownloadPoll();
    return null;
  }
};

/**
 * Destroy the session, keeping the model on disk.
 *
 * This is the honest analogue of joyce's unload-from-memory: it frees the session
 * and everything accumulated in its context window. The model itself belongs to
 * the OS and stays where it is.
 */
export const unload = () => {
  if (!session) return;
  try {
    session.destroy();
  } catch (err) {
    console.warn("[chat] session.destroy() failed:", err.message);
  }
  session = null;
  set({
    status: supported() ? STATES.ON_DISK : STATES.UNSUPPORTED,
    elapsed: null,
    revision: state.revision + 1,
  });
};

/**
 * Throw away the session and start a fresh one.
 *
 * The broom, not the trash: the point is to keep talking with an empty context
 * window, which at 90% usage is the only way to continue. Recreating rather than
 * reusing is also how a context reset actually happens -- a Prompt API session's
 * history is owned by the session, so there is nothing to clear in place.
 */
export const restart = async () => {
  const had = !!session;
  unload();
  if (had) return load();
  return null;
};

/**
 * Announce that the session's context moved.
 *
 * Context usage lives on the session object and changes without any state
 * transition, so nothing would re-render the meter after a turn. `session.js`
 * calls this when a stream finishes; the bumped revision is what pulls a fresh
 * `contextInfo()` through the subscribers.
 */
export const touch = () => set({ revision: state.revision + 1 });

/** Live context usage, straight off the session. */
export const contextInfo = () => {
  if (!session) return null;
  // Chrome renamed these mid-flight; both reference repos carry the same shim.
  const used = session.contextUsage ?? session.inputUsage ?? null;
  const total = session.contextWindow ?? session.inputQuota ?? null;
  if (used == null || total == null || !total) return null;
  return { used, total, pct: Math.round((used / total) * 100) };
};

/** Everything the info modal can honestly show. */
export const modelInfo = async () => {
  const info = {
    supported: supported(),
    availability: state.availability,
    status: state.status,
    elapsed: state.elapsed,
    error: state.error,
    context: contextInfo(),
    params: null,
  };
  if (!supported()) return info;
  try {
    // Not on every provider; treat as a bonus rather than a contract.
    info.params = (await LanguageModel.params?.()) ?? null;
  } catch {
    info.params = null;
  }
  return info;
};

/**
 * Drive the machine as far as it goes without a click.
 *
 * Called at mount when the persisted `chatEnabled` flag is true. ON_DISK is
 * promoted to READY so the first question streams immediately -- that is the
 * whole point of persisting the flag. DOWNLOADABLE deliberately stops, and the
 * download icon is then the explanation of why the preload didn't finish.
 */
export const warmUp = async () => {
  await refresh();
  if (state.status === STATES.ON_DISK) await load();
  return state;
};
