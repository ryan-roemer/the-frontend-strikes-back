import { STATES } from "./states.js";
import { byId, offered, pick, remember } from "./providers/index.js";
import { createStore } from "../store.js";

/**
 * Where the on-device model is, as one state machine driving either provider.
 *
 * A states table, an icon per state, and a primary action whose MEANING changes with the
 * state -- because what each affordance can do differs entirely by who owns the model:
 *
 *   affordance              LiteRT (page owns it)        Chrome (browser owns it)
 *   ----------------------  ---------------------------  ----------------------------
 *   download progress       real bytes, cancellable      a fraction, not cancellable
 *   free the memory         destroy the conversation     destroy the session
 *   delete from disk        a real button                NOT POSSIBLE from a page
 *   is the status a fact?   yes                          no -- availability() flaps
 *
 * ONE state object, reset on a provider switch rather than kept per provider: a switch is
 * destructive by definition, so there is nothing worth preserving across it.
 *
 * A module singleton rather than React state, because the session must outlive the panel
 * being closed.
 */

/**
 * What every state means before a provider has its say.
 *
 * Providers supply PARTIAL overrides -- usually just `title`, sometimes `action` -- and
 * everything else falls through to here. That is why `DOWNLOADING` can be a cancel button
 * on one provider and a re-check on the other without either of them restating the icon.
 */
const BASE_STATE_META = {
  [STATES.UNSUPPORTED]: {
    icon: "ph-prohibit",
    tone: "off",
    title: "Not available in this browser",
    action: null,
  },
  [STATES.UNAVAILABLE]: {
    icon: "ph-warning-circle",
    tone: "warn",
    title: "This device can't run the model",
    action: null,
  },
  [STATES.DOWNLOADABLE]: {
    icon: "ph-download-simple",
    tone: "idle",
    title: "Model not downloaded — click to fetch it",
    action: "load",
  },
  [STATES.DOWNLOADING]: {
    icon: "ph-arrows-clockwise",
    tone: "busy",
    title: "Downloading the model…",
    action: "cancel",
  },
  [STATES.ON_DISK]: {
    icon: "ph-database",
    tone: "idle",
    title: "On disk — click to start a session",
    action: "load",
  },
  // Distinct from DOWNLOADING, and both providers make conflating them tempting in
  // opposite directions: Chrome fires a download event with `loaded: 0` for a model
  // already on disk, LiteRT reports a cache hit as progress 1. Hence the rule in
  // `doLoad()` -- progress belongs to the download phase and nothing else.
  [STATES.CREATING]: {
    icon: "ph-arrows-clockwise",
    tone: "busy",
    title: "Starting a session…",
    action: null,
  },
  [STATES.READY]: {
    icon: "ph-check-circle",
    tone: "ok",
    title: "Session live — click to free it",
    action: "unload",
  },
  [STATES.ERROR]: {
    icon: "ph-warning-circle",
    tone: "error",
    title: "Failed — click to retry",
    action: "load",
  },
};

/** The active provider. Chosen at import from the stored preference; null only when the
 *  browser offers nothing that can run, which is why every read of it is `active?.`. */
let active = pick();

export const activeProvider = () => active;

/** Presentation for a state, with the active provider's overrides merged in. A function
 *  rather than a table because `DOWNLOADING` is a cancel on LiteRT and a re-check on
 *  Chrome. */
export const stateMeta = (status) => {
  const base = BASE_STATE_META[status] ?? BASE_STATE_META[STATES.UNSUPPORTED];
  const override = active?.stateMeta?.[status];
  return override ? { ...base, ...override } : base;
};

/** The switcher's data: every offered provider, and whether it can actually run. */
const providerList = () =>
  offered().map((p) => ({
    id: p.id,
    label: p.label,
    active: p.id === active?.id,
  }));

let state = {
  providerId: active?.id ?? null,
  status: STATES.UNSUPPORTED,
  /** 0..1 DURING THE DOWNLOAD ONLY, else null. See the CREATING note above. */
  progress: null,
  /** Byte counts, e.g. "412 / 2008 MB". A percentage alone cannot distinguish slow from
   *  stalled. Null on Chrome, which reports a fraction and never a total. */
  progressText: null,
  /** ms the last load took, for the label. */
  elapsed: null,
  error: null,
  /** Whether the provider is holding something expensive: a hot GPU engine, or a session. */
  resident: false,
  providers: providerList(),
  /** Bumped whenever the live session changes, so context readouts refresh. */
  revision: 0,
  /**
   * Bumped whenever the model's MEMORY is dropped -- unload, restart, delete, switch.
   *
   * Distinct from `revision`, which moves for any change worth re-rendering. This one is a
   * single claim: whatever the model remembered, it does not any more. The panel watches it
   * and wipes the transcript, so a window showing an exchange the model cannot recall --
   * where "tell me more" resolves against nothing -- is impossible by construction.
   */
  epoch: 0,
};

/**
 * The durable chat handle. Not in `state`: it is not renderable, and putting a live object
 * in a snapshot invites components to hold stale references.
 */
let chat = null;

const store = createStore(state);

/** Merge a patch and publish. Always a new object, so `getState` is a snapshot React
 *  can compare -- see `chat/store.js`. */
const set = (patch) => {
  state = { ...state, ...patch };
  store.set(state);
};

export const getState = store.get;
export const subscribe = store.subscribe;

export const getSession = () => chat;
export const isReady = () => state.status === STATES.READY && !!chat;

/** How big the download is, for copy that should not hardcode it. Null when the provider
 *  cannot know -- Chrome does not say, and inventing a number is worse than omitting it. */
export const modelSize = () => {
  const bytes = active?.capabilities.downloadBytes;
  return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : null;
};

/**
 * The system prompt, supplied by the caller.
 *
 * A function rather than a string so it can be built at session-creation time rather than at
 * import time. Set by `chat/index.js` at mount.
 */
export const DEFAULT_SYSTEM_PROMPT = () =>
  "You are a helpful assistant running on the user's own machine.";

let systemPromptFn = DEFAULT_SYSTEM_PROMPT;

export const setSystemPrompt = (fn) => {
  systemPromptFn = fn;
};

/** In-flight `doLoad()`, so concurrent callers share one attempt. */
let pendingLoad = null;

/**
 * Which generation `pendingLoad` belongs to.
 *
 * CHROME'S `create()` HAS BEEN MEASURED TO NEVER SETTLE, so `pendingLoad` cannot be
 * cleared in a `finally` alone -- that never runs, `refresh()` early-returns on the stale
 * promise forever, and the escape hatch (switch providers) lands in a machine that can no
 * longer re-sample anything.
 *
 * Anything invalidating a load in flight bumps `loadGeneration`, and both `refresh()` and
 * `load()` treat an older-generation `pendingLoad` as absent. The abandoned promise is
 * then free to never settle.
 */
let pendingGeneration = 0;

/** Is there a load in flight that we still care about? */
const loadInFlight = () =>
  Boolean(pendingLoad) && pendingGeneration === loadGeneration;

/**
 * Bumped by anything that invalidates a load in flight (`unload`, `cancelDownload`,
 * `deleteDownload`, `switchProvider`).
 *
 * A create hands back no handle until it resolves, so there is a window in which a cancel
 * has nothing to cancel. Without this check a ~2 GB engine lands resident with nothing
 * referencing it, or a session is created for a panel the presenter has already dismissed.
 */
let loadGeneration = 0;

/** Aborts the download's `fetch`. Null unless a cancellable download is in flight. */
let downloadAbort = null;

/**
 * Ask where things stand, without downloading or building anything.
 *
 * Cheap on both providers: a memoized GPU probe plus a Cache API lookup on LiteRT, a single
 * `availability()` call on Chrome. Never promotes to READY -- a live session is a thing we
 * hold, not a thing to discover.
 */
export const refresh = async () => {
  if (!active) {
    set({ status: STATES.UNSUPPORTED, error: "No on-device model available." });
    return state;
  }
  if (chat) {
    set({ status: STATES.READY });
    return state;
  }
  // A load in flight owns the status. The panel calls `refresh()` every time it opens, and
  // without this, opening it mid-download finds no cache entry, reports DOWNLOADABLE, and
  // puts a second multi-gigabyte fetch one click away. Generation-checked, so a load that
  // will never settle cannot pin this closed forever.
  if (loadInFlight()) return state;

  const status = await active.status();
  set({
    status,
    error: status === STATES.ERROR ? state.error : null,
    progress: null,
    progressText: null,
    resident: active.resident(),
  });
  return state;
};

/** Point the active provider's promotion callback at this machine. See the call at the
 *  bottom of the file, and the matching call in `switchProvider`. */
const watchPromotion = () => {
  active?.onPromoted?.(() => {
    if (!chat) refresh();
  });
};

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
 * Download the model if needed, create the session.
 *
 * TWO PHASES, KEPT APART, which is the whole design. A `create()` secretly waiting on a
 * download surfaces as "the model took too long to start" -- wrong and unactionable. Here
 * the download is a state of its own with no deadline, and only the create is bounded.
 */
const doLoad = async () => {
  const startedAt = Date.now();
  const generation = ++loadGeneration;
  const superseded = () => generation !== loadGeneration;

  const provider = active;
  const { ownsBytes } = provider.capabilities;
  const { stallMs, createCeilingMs } = provider.timings;

  // Outside the main try, so it needs its own: `load()` is called bare from a click
  // handler, and a throw here would reject as an unhandled rejection with nothing
  // written to state.
  let before;
  try {
    before = await provider.status();
    if (before === STATES.UNSUPPORTED || before === STATES.UNAVAILABLE) {
      const gpu = await provider.probe();
      set({ status: before, error: gpu.reason });
      return null;
    }
  } catch (err) {
    if (superseded()) return null;
    set({ status: STATES.ERROR, error: err.message, progress: null });
    return null;
  }

  let stalled = false;

  // The download gets NO deadline: 2 GB on venue wifi is legitimately many minutes, so any
  // fixed limit punishes patience. An idle timer fires only when nothing is arriving.
  const stall = idleTimer(stallMs, () => {
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
        () => reject(new Error("The model timed out starting up.")),
        createCeilingMs,
      );
    };
    stopCeiling = () => clearTimeout(timer);
  });

  if (before === STATES.ON_DISK) {
    set({
      status: STATES.CREATING,
      progress: null,
      progressText: null,
      error: null,
    });
    armCeiling();
  } else {
    // Only reachable from a deliberate click.
    if (ownsBytes) downloadAbort = new AbortController();
    set({
      status: STATES.DOWNLOADING,
      progress: 0,
      progressText: ownsBytes ? "starting…" : null,
      error: null,
    });
    stall.arm();
    // Chrome's download is not ours to watch a byte at a time, and `create()` may sit on it
    // for minutes. The ceiling is the only bound that applies.
    if (!ownsBytes) armCeiling();
  }

  try {
    const handle = await Promise.race([
      provider.acquire({
        system: systemPromptFn(),
        signal: downloadAbort?.signal ?? null,
        onPhase: (ev) => {
          if (superseded()) return;
          if (ev.phase === "download") {
            stall.arm();
            set({
              status: STATES.DOWNLOADING,
              progress: ev.progress,
              progressText: ev.text ?? null,
            });
            return;
          }
          stall.stop();
          armCeiling();
          // THE NULLS ARE MANDATORY. A LiteRT cache hit reports progress 1, and carrying
          // that into CREATING shows a frozen 100% for the whole load.
          set({ status: STATES.CREATING, progress: null, progressText: null });
        },
      }),
      ceiling,
    ]);

    // A late arrival is torn down, not kept: Chrome's `create()` hands back no handle until
    // it resolves, so a session can land seconds after the presenter switched providers.
    if (superseded()) {
      handle.destroy();
      return null;
    }

    chat = handle;
    set({
      status: STATES.READY,
      progress: null,
      progressText: null,
      elapsed: Date.now() - startedAt,
      error: null,
      resident: provider.resident(),
      revision: state.revision + 1,
    });
    return chat;
  } catch (err) {
    // A DELIBERATE CANCEL NEVER LANDS HERE: `cancelDownload()` bumps the generation before
    // aborting and owns its own repaint. Everything below is a real failure.
    if (superseded()) return null;

    // A timeout says nothing about the model, only that we stopped waiting -- so ask the
    // provider rather than guessing. On Chrome this is usually a download that started
    // underneath us, and "downloading" is the honest answer.
    const timedOut = /timed out/i.test(err.message);
    const settled = timedOut
      ? await provider.status().catch(() => STATES.ERROR)
      : STATES.ERROR;

    set({
      status: settled,
      progress: null,
      progressText: null,
      error:
        settled !== STATES.ERROR
          ? null
          : stalled
            ? "The download stopped making progress. Check the network and try again."
            : err.message,
      resident: provider.resident(),
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
 * Never speculatively on a DOWNLOADABLE model: on LiteRT that download is 2 GB, and firing
 * it on page load would be both expensive and rude.
 */
export const load = async () => {
  if (chat) return chat;
  if (!active) return null;

  // A second click and a submitted question can both ask for a session while one is
  // loading; they wait on the same promise rather than building two. Generation-checked,
  // so a presenter escaping a hung Chrome create is not made to wait on it again.
  if (loadInFlight()) return pendingLoad;

  const attempt = doLoad();
  pendingLoad = attempt;
  pendingGeneration = loadGeneration;
  try {
    return await attempt;
  } finally {
    if (pendingLoad === attempt) pendingLoad = null;
  }
};

/**
 * Stop a download in progress. Only meaningful when the provider owns the bytes; on
 * Chrome the same slot is a re-check, so this is never wired to a button there.
 *
 * IT MUST REPAINT ITSELF. Bumping the generation stops the abandoned `doLoad()` writing
 * state after the fact -- which also means its catch returns early and never repaints.
 * Without the `refresh()` the panel sits on DOWNLOADING with a frozen progress bar.
 */
export const cancelDownload = async () => {
  loadGeneration += 1;
  downloadAbort?.abort();
  return refresh();
};

/**
 * Free the conversation.
 *
 * On LiteRT the ENGINE deliberately stays resident. The buttons that come here exist to be
 * pressed mid-talk, and reloading 2 GB onto the GPU from a control whose purpose is to let
 * you carry on talking would make it useless. The conversation is what matters anyway --
 * that is where the context window lives.
 *
 * Synchronous, because the click handler does not await it.
 */
export const unload = () => {
  // Bumped even when there is no session yet: during CREATING `chat` is still null, so an
  // early return here would silently leave a load running that nobody wants.
  loadGeneration += 1;

  if (chat) {
    try {
      chat.destroy();
    } catch (err) {
      console.warn("[chat] destroying the session failed:", err.message);
    }
    chat = null;
  }
  active?.release();

  set({
    status: STATES.ON_DISK,
    elapsed: null,
    progress: null,
    progressText: null,
    resident: active?.resident() ?? false,
    revision: state.revision + 1,
    epoch: state.epoch + 1,
  });
  // The provider is the authority on the status now. Caught because this function is
  // synchronous, so nothing is around to handle a rejection.
  refresh().catch(() => {});
};

/**
 * Throw away the conversation and start a fresh one.
 *
 * The broom, not the trash: the point is to keep talking with an empty context window,
 * which at 90% usage is the only way to continue.
 *
 * Cheap on LiteRT (~2ms -- the engine stays hot and a new conversation prefills its preface
 * lazily) and expensive on Chrome, where it is a full `create()`. So an expensive restart
 * shows CREATING rather than pretending to be instant.
 */
export const restart = async () => {
  if (!chat) return load();

  const cheap = active?.capabilities.cheapRestart;
  if (!cheap) set({ status: STATES.CREATING, error: null });

  try {
    await chat.restart();
    set({
      status: STATES.READY,
      elapsed: null,
      revision: state.revision + 1,
      epoch: state.epoch + 1,
    });
    return chat;
  } catch (err) {
    // A failed restart on Chrome leaves no usable session: it destroys the old one only
    // after the new one resolves, so a rejection vouches for neither.
    chat = null;
    set({
      status: STATES.ERROR,
      error: err.message,
      revision: state.revision + 1,
      epoch: state.epoch + 1,
    });
    return null;
  }
};

/**
 * Delete the downloaded model. Only offered when the provider owns the bytes.
 *
 * A download in flight is aborted FIRST, so its `cache.put` cannot re-create the entry
 * `remove()` just deleted. The status is then asked for rather than asserted, so a delete
 * that failed does not report DOWNLOADABLE over a model still on disk.
 */
export const deleteDownload = async () => {
  if (!active?.capabilities.canDelete) return false;
  loadGeneration += 1;
  downloadAbort?.abort();
  if (chat) {
    try {
      chat.destroy();
    } catch (err) {
      // A handle that will not tear down must not stop the bytes from going.
      console.warn("[chat] destroying the session failed:", err.message);
    }
    chat = null;
  }
  const removed = await active.remove();
  set({
    elapsed: null,
    error: null,
    progress: null,
    progressText: null,
    resident: false,
    revision: state.revision + 1,
    epoch: state.epoch + 1,
  });
  await refresh();
  return removed;
};

/**
 * Move to the other provider.
 *
 * Destructive on purpose, and the `epoch` bump is the important part: the two providers
 * have entirely separate memories, so a transcript carried across would show an exchange
 * the new model has never seen. The panel wipes it from that one signal.
 *
 * Must stay callable from EVERY state, including CREATING. This is the escape hatch from a
 * Chrome `create()` that never resolves, and an escape hatch that is disabled while the
 * thing it escapes is happening is not one.
 */
export const switchProvider = async (id) => {
  const next = byId(id);
  if (!next || next === active) return state;

  // Invalidate anything in flight FIRST, so a load that resolves later finds itself
  // superseded and tears its own handle down.
  loadGeneration += 1;

  const previous = active;
  if (chat) {
    try {
      chat.destroy();
    } catch {
      /* already gone */
    }
    chat = null;
  }
  // EVICT, not release. `release()` keeps LiteRT's engine hot for the broom; switching away
  // means nothing references those ~2 GB until the presenter switches back.
  await previous?.evict().catch(() => {});

  active = next;
  remember(next.id);
  watchPromotion();

  set({
    providerId: next.id,
    providers: providerList(),
    status: STATES.CREATING,
    progress: null,
    progressText: null,
    elapsed: null,
    error: null,
    resident: false,
    revision: state.revision + 1,
    epoch: state.epoch + 1,
  });

  return refresh();
};

/**
 * Announce that the session's context moved.
 *
 * Context usage changes without any state transition, so nothing would re-render the meter
 * after a turn. `session.js` calls this when a stream finishes; the bumped revision pulls a
 * fresh `contextInfo()` through the subscribers, and the resample updates the number behind
 * it on providers that need one.
 */
export const touch = () => {
  set({ revision: state.revision + 1 });
  // A failed sample is a stale meter; an unhandled rejection is a console error mid-talk.
  chat
    ?.sampleContext()
    .then(() => set({ revision: state.revision + 1 }))
    .catch(() => {});
};

/** Live context usage. Synchronous: LiteRT caches an async sample behind this, Chrome
 *  reads its session directly. */
export const contextInfo = () => chat?.context() ?? null;

/** Everything the info modal can honestly show. Generic rows first, then the provider's. */
export const modelInfo = async () => {
  const context = contextInfo();
  const rows = [
    ["Status", stateMeta(state.status).title],
    ["Provider", active?.label ?? "none"],
    ...(await (active?.info() ?? Promise.resolve([]))),
    [
      "Context",
      context
        ? `${context.used.toLocaleString()} / ${context.total.toLocaleString()} (${context.pct}%)`
        : "no session",
    ],
    ["Loaded in", formatMs(state.elapsed) ?? "—"],
  ];

  const bench = chat ? await chat.benchmark() : null;
  // Omitted rather than shown as zeroes on a session that has not generated yet:
  // "0 in, 0 out · 0 tok/s" reads as a broken readout.
  if (bench?.lastDecodeTokenCount) {
    rows.push([
      "Last turn",
      `${bench.lastPrefillTokenCount ?? "?"} in, ${bench.lastDecodeTokenCount} out · ` +
        `${Math.round(bench.lastDecodeTokensPerSecond ?? 0)} tok/s`,
    ]);
  }
  if (state.error) rows.push(["Last error", state.error]);

  return {
    rows,
    // Derived from the status: every state except these two implies the bytes are present,
    // and offering "delete 2.0 GB" for bytes never fetched is worse than offering nothing.
    canDelete:
      Boolean(active?.capabilities.canDelete) &&
      state.status !== STATES.DOWNLOADABLE &&
      state.status !== STATES.DOWNLOADING,
    size: modelSize(),
    manageNote: active?.manageNote ?? null,
  };
};

const formatMs = (ms) =>
  ms == null ? null : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

/** The copy shown in place of the transcript when the model cannot run at all. */
export const unavailableCopy = (status) =>
  active?.unavailableCopy(status) ?? {
    lead: "No on-device model is available in this browser.",
    bullets: [],
  };

// A background download finishing is the one thing that changes status without us asking.
// Chrome fires no event for it, so its provider polls and calls this.
//
// RE-REGISTERED ON EVERY PROVIDER SWITCH, because `onPromoted` is a single slot on the
// provider module rather than a subscription list -- registering once at import wires up
// only whichever provider happened to be stored.
watchPromotion();
