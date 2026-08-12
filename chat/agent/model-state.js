/* global console:false, setTimeout:false, clearTimeout:false, AbortController:false */
import {
  MAX_NUM_TOKENS,
  MODEL,
  MODEL_BYTES,
  MODEL_URL,
  createChat,
  deleteModel,
  engineResident,
  ensureEngine,
  isModelCached,
  probe,
  wasmUrl,
} from "./providers/litert.js";
import {
  cacheAvailable,
  gb,
  requestPersistence,
  storageRoom,
} from "./providers/litert-cache.js";

/**
 * Where the on-device model is, as one small state machine.
 *
 * Shaped after joyce's `LoadingButton`: a states table, an icon per state, and a primary
 * action whose MEANING changes with the state. What each affordance can actually do is the
 * part worth reading, because it changed completely when the provider did.
 *
 * Under the Chrome Prompt API the model belonged to the browser. A page could ask whether it
 * was available and could destroy its own session, but it could not download the model on
 * purpose, could not watch real progress, and could not delete it -- the mapping table that
 * used to live here said "delete from disk: NOT POSSIBLE from a page", and pointed at
 * `chrome://on-device-internals` instead.
 *
 * Under LiteRT the page owns the bytes. So the table is now:
 *
 *   cached (bytes on disk)     ON_DISK -- verified complete, engine may or may not be hot
 *   loaded -> unload memory    READY -> destroy the conversation, freeing its context
 *   delete from disk           A REAL BUTTON. See `deleteDownload()`.
 *
 * That is the biggest single gain from the swap and it is why this file no longer apologises
 * for anything.
 *
 * The machine is a module singleton rather than React state because the session must outlive
 * the panel being closed, and because `plan.js` needs it without being a component.
 */

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

/** How big the download is, in the copy, everywhere it might be triggered. */
const SIZE = `${gb(MODEL_BYTES)} GB`;

/** Presentation for each state: Phosphor icon, label, and what a click does. */
export const STATE_META = {
  [STATES.UNSUPPORTED]: {
    icon: "ph-prohibit",
    tone: "off",
    title: "This browser can't run WebGPU",
    action: null,
  },
  [STATES.UNAVAILABLE]: {
    icon: "ph-warning-circle",
    tone: "warn",
    title: "This device's GPU can't run the model",
    action: null,
  },
  [STATES.DOWNLOADABLE]: {
    // The size is in the label because this click starts a multi-gigabyte fetch. A
    // presenter who triggers that unknowingly on venue wifi has a genuine problem, and
    // "click to download" alone does not warn anybody.
    icon: "ph-download-simple",
    tone: "idle",
    title: `Model not downloaded — click to fetch it (${SIZE})`,
    action: "load",
  },
  [STATES.DOWNLOADING]: {
    icon: "ph-arrows-clockwise",
    tone: "busy",
    // Clickable, unlike the other busy state -- and it now does something real. Under the
    // Prompt API the download was Chrome's, so the only honest option was to re-check it.
    // This download is ours, so it can be stopped.
    title: "Downloading the model… (click to stop)",
    action: "cancel",
  },
  [STATES.ON_DISK]: {
    icon: "ph-database",
    tone: "idle",
    title: "On disk — click to start a session",
    action: "load",
  },
  // Distinct from DOWNLOADING, because conflating them tells a lie that shows. Both
  // providers have made the same lie available in opposite directions: Chrome fired a
  // download event with `loaded: 0` for a model already on disk, which showed
  // "Downloading… (0%)" forever; LiteRT reports a cache hit as progress 1, which would show
  // a frozen "100%" through the whole GPU load. Hence the rule in `doLoad()`: progress
  // belongs to the download phase and NOTHING else.
  [STATES.CREATING]: {
    icon: "ph-arrows-clockwise",
    tone: "busy",
    title: "Loading the model onto the GPU…",
    action: null,
  },
  [STATES.READY]: {
    icon: "ph-check-circle",
    tone: "ok",
    // The engine stays hot deliberately -- see `unload()`.
    title: "Session live — click to free the conversation",
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
  /** 0..1 DURING THE DOWNLOAD ONLY, else null. See the CREATING note above. */
  progress: null,
  /** Byte counts, e.g. "412 / 2008 MB". A percentage alone cannot distinguish slow from stalled. */
  progressText: null,
  /** ms the last load took, for the label -- joyce shows this too. */
  elapsed: null,
  error: null,
  /** Whether the GPU engine is hot, which ON_DISK alone no longer tells you. */
  engineResident: false,
  /** Bumped whenever the live session changes, so context readouts refresh. */
  revision: 0,
};

/**
 * The durable chat session. Not in `state`: it is not renderable, and putting a live object
 * in a snapshot invites components to hold stale references.
 */
let chat = null;

/** Last sampled token count. See `contextInfo()` for why this is cached rather than read. */
let lastTokens = null;

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

export const getSession = () => chat;
export const isReady = () => state.status === STATES.READY && !!chat;

/** Size and identity, for copy that should not hardcode either. */
export const modelSize = () => SIZE;

/**
 * Ask where things stand, without downloading or building anything.
 *
 * Cheap: a memoized GPU probe plus a Cache API lookup. Never promotes to READY -- a live
 * session is a thing we hold, not a thing to discover.
 */
export const refresh = async () => {
  const gpu = await probe();
  if (!gpu.supported) {
    set({ status: STATES.UNSUPPORTED, error: gpu.reason });
    return state;
  }
  if (!gpu.ok) {
    set({ status: STATES.UNAVAILABLE, error: gpu.reason });
    return state;
  }
  if (chat) {
    set({ status: STATES.READY });
    return state;
  }
  // A load in flight already owns the status, and this early return matters far MORE than
  // it did under the Prompt API: it now guards a window measured in minutes rather than
  // seconds. The panel calls `refresh()` every time it opens, and without this, opening the
  // panel mid-download would find no cache entry, report DOWNLOADABLE, and put a second
  // multi-gigabyte fetch one click away.
  if (pendingLoad) return state;

  const cached = await isModelCached();
  set({
    status: cached ? STATES.ON_DISK : STATES.DOWNLOADABLE,
    error: null,
    progress: null,
    progressText: null,
    engineResident: engineResident(),
  });
  return state;
};

/**
 * The system prompt, supplied by the caller.
 *
 * A function rather than a string because the deck knowledge it embeds is harvested from the
 * live DOM, so it cannot be built at import time. Set by `chat/index.js` at mount.
 */
let systemPromptFn = () =>
  "You are a helpful assistant embedded in a slide deck.";

export const setSystemPrompt = (fn) => {
  systemPromptFn = fn;
};

/** In-flight `doLoad()`, so concurrent callers share one attempt. */
let pendingLoad = null;

/**
 * Bumped by anything that invalidates a load in flight (`unload`, `cancelDownload`,
 * `deleteDownload`).
 *
 * `Engine.create()` hands back no handle until it resolves, so there is a window in which a
 * cancel has nothing to cancel. Without this check a ~2 GB engine lands resident with
 * nothing referencing it, or a conversation is created for a session the presenter has
 * already dismissed.
 */
let loadGeneration = 0;

/** Aborts the download's `fetch`. Null unless a download is in flight. */
let downloadAbort = null;

/**
 * Ceiling on building the engine. NOT on the download -- see `doLoad()`.
 *
 * Measured: 3.0s cold, 1.2s from a warm cache. So this is not a performance budget, it is a
 * wedge detector, and it is deliberately far above anything observed.
 */
const ENGINE_CEILING_MS = 120000;

/**
 * How long the download may produce no bytes before we call it dead.
 *
 * The download itself gets NO deadline: 2 GB on venue wifi is legitimately many minutes, and
 * any fixed limit would be a lie told to a presenter who is merely being patient. An idle
 * timer is the honest bound -- it fires only when nothing is actually arriving. Same shape
 * as the per-chunk timer in `session.js`.
 */
const STALL_MS = 60000;

const idleTimer = (ms, onIdle) => {
  let timer = null;
  return {
    arm() {
      clearTimeout(timer);
      timer = setTimeout(onIdle, ms);
    },
    stop() {
      clearTimeout(timer);
    },
  };
};

/**
 * Download the model if needed, build the engine, open a conversation.
 *
 * Two phases, and keeping them apart is the whole design. Under the Prompt API a `create()`
 * that was secretly waiting on a download surfaced as "the model took too long to start",
 * which was both wrong and unactionable. Here the download is a state of its own, with real
 * byte progress and no deadline, and only the GPU load is bounded.
 */
const doLoad = async () => {
  const startedAt = Date.now();
  const generation = ++loadGeneration;
  const superseded = () => generation !== loadGeneration;

  const gpu = await probe();
  if (!gpu.supported) {
    set({ status: STATES.UNSUPPORTED, error: gpu.reason });
    return null;
  }
  if (!gpu.ok) {
    set({ status: STATES.UNAVAILABLE, error: gpu.reason });
    return null;
  }

  const cached = await isModelCached();
  let stalled = false;

  const stall = idleTimer(STALL_MS, () => {
    stalled = true;
    downloadAbort?.abort();
  });

  let armCeiling = () => {};
  let stopCeiling = () => {};
  const ceiling = new Promise((_, reject) => {
    let timer = null;
    armCeiling = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error("The model timed out loading onto the GPU.")),
        ENGINE_CEILING_MS,
      );
    };
    stopCeiling = () => clearTimeout(timer);
  });

  if (cached) {
    set({
      status: STATES.CREATING,
      progress: null,
      progressText: null,
      error: null,
    });
    armCeiling();
  } else {
    // Only from a deliberate click, so this is the one place where asking to be exempt from
    // eviction is appropriate: activation exists, and on Firefox the permission prompt it
    // may raise is at least in context rather than out of nowhere.
    await requestPersistence();
    downloadAbort = new AbortController();
    set({
      status: STATES.DOWNLOADING,
      progress: 0,
      progressText: "starting…",
      error: null,
    });
    stall.arm();
  }

  try {
    await Promise.race([
      ensureEngine({
        signal: downloadAbort?.signal ?? null,
        onProgress: (ev) => {
          if (superseded()) return;
          if (ev.phase === "download") {
            stall.arm();
            set({
              status: STATES.DOWNLOADING,
              progress: ev.progress,
              progressText: ev.text,
            });
            return;
          }
          stall.stop();
          armCeiling();
          // THE NULLS ARE MANDATORY. A cache hit reports progress 1, and carrying that into
          // CREATING shows a frozen 100% for the whole GPU load.
          set({
            status: STATES.CREATING,
            progress: null,
            progressText: null,
          });
        },
      }),
      ceiling,
    ]);

    if (superseded()) return null;

    chat = await createChat({ system: systemPromptFn() });

    // The conversation is cheap (~2ms) but it is still possible for the presenter to have
    // dismissed everything while the engine was loading.
    if (superseded()) {
      chat.destroy();
      chat = null;
      return null;
    }

    lastTokens = 0;
    set({
      status: STATES.READY,
      progress: null,
      progressText: null,
      elapsed: Date.now() - startedAt,
      error: null,
      engineResident: true,
      revision: state.revision + 1,
    });
    return chat;
  } catch (err) {
    if (superseded()) return null;

    // A stall is a failure; a cancel is not. Reporting a red icon for a download the
    // presenter stopped on purpose would be a worse lie than saying nothing.
    const cancelled = !stalled && err.name === "AbortError";
    const nowCached = await isModelCached().catch(() => false);

    set({
      status: cancelled
        ? nowCached
          ? STATES.ON_DISK
          : STATES.DOWNLOADABLE
        : STATES.ERROR,
      progress: null,
      progressText: null,
      error: cancelled
        ? null
        : stalled
          ? "The download stopped making progress. Check the network and try again."
          : err.message,
      engineResident: engineResident(),
      revision: state.revision + 1,
    });
    return null;
  } finally {
    stall.stop();
    stopCeiling();
    downloadAbort = null;
  }
};

/**
 * Start a session.
 *
 * Only called from a click, or from a question typed while the model is already ON_DISK.
 * Never speculatively on a DOWNLOADABLE model: that download is 2 GB, and firing it on page
 * load would be both expensive and rude.
 */
export const load = async () => {
  if (chat) return chat;

  // Loading takes seconds at best and minutes at worst, which is ample time for a second
  // click and a submitted question to both ask for a session. Handing back the in-flight
  // promise means they wait on the same one instead of racing to build two engines.
  if (pendingLoad) return pendingLoad;

  pendingLoad = doLoad();
  try {
    return await pendingLoad;
  } finally {
    pendingLoad = null;
  }
};

/** Stop a download in progress. Newly possible: this download is ours. */
export const cancelDownload = () => {
  loadGeneration += 1;
  downloadAbort?.abort();
};

/**
 * Free the conversation, keeping the ENGINE hot and the bytes on disk.
 *
 * The engine deliberately stays resident. It is ~2 GB of GPU memory, so freeing it looks
 * like the tidy thing to do -- but the buttons that come here are the header's broom and the
 * header bar's trash, both of which exist to be pressed MID-TALK. Reloading 2 GB onto the
 * GPU from a button whose whole purpose is to let you carry on talking would make both
 * useless. Freeing the conversation is what actually matters anyway: that is where the
 * context window lives.
 *
 * Synchronous, because `model-status.js` calls it from a click without awaiting.
 */
export const unload = () => {
  // Bumped even when there is no conversation yet: during CREATING `chat` is still null, so
  // an early return here would silently leave a load running that nobody wants.
  loadGeneration += 1;

  if (chat) {
    try {
      chat.destroy();
    } catch (err) {
      console.warn("[chat] destroying the conversation failed:", err.message);
    }
    chat = null;
  }
  lastTokens = null;

  const hot = engineResident();
  set({
    status: hot ? STATES.ON_DISK : STATES.DOWNLOADABLE,
    elapsed: null,
    progress: null,
    progressText: null,
    engineResident: hot,
    revision: state.revision + 1,
  });
  // Only reachable if the engine was never built; the Cache API is the authority on which
  // of the two states above is true.
  if (!hot) refresh();
};

/**
 * Throw away the conversation and start a fresh one.
 *
 * The broom, not the trash: the point is to keep talking with an empty context window, which
 * at 90% usage is the only way to continue. A `Conversation` owns its history, so there is
 * nothing to clear in place -- exactly as with a Prompt API session. The difference is the
 * price: measured at 2ms, because the engine stays hot and a new conversation prefills its
 * preface lazily.
 */
export const restart = async () => {
  if (!chat) return load();
  await chat.restart();
  lastTokens = 0;
  set({ elapsed: null, revision: state.revision + 1 });
  return chat;
};

/** Delete the downloaded model. The affordance the Prompt API could not offer at all. */
export const deleteDownload = async () => {
  loadGeneration += 1;
  if (chat) {
    chat.destroy();
    chat = null;
  }
  lastTokens = null;
  const removed = await deleteModel();
  set({
    status: STATES.DOWNLOADABLE,
    elapsed: null,
    error: null,
    progress: null,
    progressText: null,
    engineResident: false,
    revision: state.revision + 1,
  });
  return removed;
};

/**
 * Sample the context usage.
 *
 * `getTokenCount()` is async but `contextInfo()` must be synchronous, so the number is
 * cached here and the cache is refreshed out of band. Two renders per turn, which is
 * cheaper than it sounds because the second only changes one number.
 */
let sampling = false;

const sampleContext = () => {
  if (!chat || sampling) return;
  sampling = true;
  chat
    .tokenCount()
    .then((n) => {
      sampling = false;
      if (n == null || !chat) return;
      lastTokens = n;
      set({ revision: state.revision + 1 });
    })
    .catch(() => {
      sampling = false;
    });
};

/**
 * Announce that the session's context moved.
 *
 * Context usage changes without any state transition, so nothing would re-render the meter
 * after a turn. `session.js` calls this when a stream finishes; the bumped revision pulls a
 * fresh `contextInfo()` through the subscribers, and the resample updates the number behind
 * it.
 */
export const touch = () => {
  set({ revision: state.revision + 1 });
  sampleContext();
};

/**
 * Live context usage.
 *
 * Synchronous because it is called in a component body, so it reads the cached sample rather
 * than the model. `total` is not discovered from anywhere -- it is the KV-cache budget we
 * asked for. Reads 0 on a fresh conversation, which is honest: the preface prefills lazily,
 * so nothing has been spent yet.
 */
export const contextInfo = () => {
  if (!chat || lastTokens == null) return null;
  return {
    used: lastTokens,
    total: MAX_NUM_TOKENS,
    pct: Math.round((lastTokens / MAX_NUM_TOKENS) * 100),
  };
};

/** Everything the info modal can honestly show -- which is now a great deal more. */
export const modelInfo = async () => {
  const gpu = await probe();
  const info = {
    status: state.status,
    elapsed: state.elapsed,
    error: state.error,
    context: contextInfo(),
    model: MODEL,
    size: SIZE,
    bytes: MODEL_BYTES,
    url: MODEL_URL,
    backend: "GPU_ARTISAN",
    maxNumTokens: MAX_NUM_TOKENS,
    gpu,
    cacheAvailable,
    engineResident: engineResident(),
    cached: false,
    wasm: null,
    storage: null,
    benchmark: null,
  };
  try {
    info.wasm = wasmUrl();
  } catch (err) {
    info.wasm = `unresolved: ${err.message}`;
  }
  info.cached = await isModelCached().catch(() => false);
  info.storage = await storageRoom(MODEL_BYTES).catch(() => null);
  if (chat) info.benchmark = await chat.benchmark();
  return info;
};

/**
 * Drive the machine as far as it goes without a click.
 *
 * Called at mount when the persisted `chatEnabled` flag is true, and it STOPS at ON_DISK --
 * it does not build the engine.
 *
 * This is a deliberate reversal. Under the Prompt API, warming up meant promoting ON_DISK to
 * READY so the first question streamed immediately, and the session it created was the OS's,
 * costing ~9.5s. The same promotion under LiteRT means claiming ~2 GB of GPU memory during
 * page load, racing Spectacle's 35-slide portal mount and react-spring's animations. Safari
 * enforces per-tab memory limits by KILLING THE TAB rather than throwing, so the worst case
 * is not a slow deck, it is no deck at all, before slide 1.
 *
 * The engine loads in ~1.2s from a warm cache, so the first question pays almost nothing for
 * this. That is a very cheap price for not gambling the talk.
 */
export const warmUp = async () => {
  await refresh();
  return state;
};
