/* global console:false, setTimeout:false, clearTimeout:false, AbortController:false */
import { STATES } from "./states.js";
import { byId, offered, pick, remember } from "./providers/index.js";

/**
 * Where the on-device model is, as one small state machine -- for either provider.
 *
 * Shaped after joyce's `LoadingButton`: a states table, an icon per state, and a primary
 * action whose MEANING changes with the state. What each affordance can actually do is the
 * part worth reading, because it is completely different depending on who owns the model.
 *
 *   affordance              LiteRT (page owns it)        Chrome (browser owns it)
 *   ----------------------  ---------------------------  ----------------------------
 *   download progress       real bytes, cancellable      a fraction, not cancellable
 *   free the memory         destroy the conversation     destroy the session
 *   delete from disk        a real button                NOT POSSIBLE from a page
 *   is the status a fact?   yes                          no -- availability() flaps
 *
 * The machine holds ONE state object, reset on a provider switch rather than kept per
 * provider. Four components read `state.status` flat, so slices would force every one of
 * them to learn which provider is active -- and a switch is destructive by definition (it
 * bumps `epoch` and tears down the conversation), so there is nothing worth preserving
 * across it.
 *
 * A module singleton rather than React state, because the session must outlive the panel
 * being closed.
 */

export { STATES };

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
  // Distinct from DOWNLOADING, because conflating them tells a lie that shows. Both
  // providers have made the same lie available in opposite directions: Chrome fires a
  // download event with `loaded: 0` for a model already on disk, which showed
  // "Downloading… (0%)" forever; LiteRT reports a cache hit as progress 1, which would show
  // a frozen "100%" through the whole GPU load. Hence the rule in `doLoad()`: progress
  // belongs to the download phase and NOTHING else.
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

/** The active provider. Never null once `init()` has run, unless nothing is offered. */
let active = pick();

export const activeProvider = () => active;

/**
 * Presentation for a state, with the active provider's overrides merged in.
 *
 * Replaces what used to be an exported `STATE_META` table. A plain object could not work
 * once the same state means different things per provider -- `DOWNLOADING` is a cancel
 * button on LiteRT and a re-check on Chrome.
 */
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
  /** ms the last load took, for the label -- joyce shows this too. */
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
   * and wipes the transcript, so the two can never disagree.
   *
   * They used to. Freeing the conversation from the status row left the transcript on
   * screen, so the window showed an exchange the model had no memory of -- and a follow-up
   * like "tell me more" would then resolve against nothing.
   */
  epoch: 0,
};

/**
 * The durable chat handle. Not in `state`: it is not renderable, and putting a live object
 * in a snapshot invites components to hold stale references.
 */
let chat = null;

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
let systemPromptFn = () =>
  "You are a helpful assistant running on the user's own machine.";

export const setSystemPrompt = (fn) => {
  systemPromptFn = fn;
};

/** In-flight `doLoad()`, so concurrent callers share one attempt. */
let pendingLoad = null;

/**
 * Which generation `pendingLoad` belongs to.
 *
 * THIS FIELD EXISTS BECAUSE OF A REAL WEDGE, and it is the most important two lines in the
 * file. `pendingLoad` was previously cleared only in `load()`'s `finally` -- which never
 * runs if `doLoad()` never settles. Chrome's `create()` has been measured to never settle.
 * So a hung Chrome load pinned `pendingLoad` forever, `refresh()` early-returned on it
 * forever, and the escape hatch (switch back to LiteRT) landed in a state machine that
 * could no longer re-sample anything. The bail-out was itself wedged.
 *
 * Anything that invalidates a load in flight bumps `loadGeneration`, and both `refresh()`
 * and `load()` treat a `pendingLoad` from an older generation as absent. The abandoned
 * promise is then free to never settle; nothing is waiting on it.
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
  // A load in flight already owns the status, and this early return matters far more on
  // LiteRT than it did under the Prompt API: it guards a window measured in minutes rather
  // than seconds. The panel calls `refresh()` every time it opens, and without this,
  // opening the panel mid-download would find no cache entry, report DOWNLOADABLE, and put
  // a second multi-gigabyte fetch one click away.
  //
  // Generation-checked, so a load that will never settle cannot pin this closed forever.
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
 * Two phases, and keeping them apart is the whole design. A `create()` that is secretly
 * waiting on a download surfaces as "the model took too long to start", which is both wrong
 * and unactionable -- that was the Prompt API's actual failure mode. Here the download is a
 * state of its own, with no deadline, and only the create is bounded.
 */
const doLoad = async () => {
  const startedAt = Date.now();
  const generation = ++loadGeneration;
  const superseded = () => generation !== loadGeneration;

  const provider = active;
  const { ownsBytes } = provider.capabilities;
  const { stallMs, createCeilingMs } = provider.timings;

  const before = await provider.status();
  if (before === STATES.UNSUPPORTED || before === STATES.UNAVAILABLE) {
    const gpu = await provider.probe();
    set({ status: before, error: gpu.reason });
    return null;
  }

  let stalled = false;

  // The download itself gets NO deadline: 2 GB on venue wifi is legitimately many minutes,
  // and any fixed limit would be a lie told to a presenter who is merely being patient. An
  // idle timer is the honest bound -- it fires only when nothing is actually arriving.
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

    // A late arrival must be torn down, not kept. Easy to omit on Chrome, whose `create()`
    // hands back no handle until it resolves -- so a session can land seconds after the
    // presenter has switched providers, holding its context with nothing referencing it.
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
    if (superseded()) return null;

    // A stall is a failure; a cancel is not. Reporting a red icon for a download the
    // presenter stopped on purpose would be a worse lie than saying nothing.
    const cancelled = !stalled && err.name === "AbortError";

    // A timeout says nothing about the model, only that we stopped waiting -- so ask the
    // provider where things stand instead of guessing. On Chrome this is usually a download
    // that started underneath us, and "downloading" is the honest answer.
    const timedOut = /timed out/i.test(err.message);
    const settled =
      cancelled || timedOut
        ? await provider.status().catch(() => STATES.ERROR)
        : STATES.ERROR;

    set({
      status: settled,
      progress: null,
      progressText: null,
      error:
        cancelled || settled !== STATES.ERROR
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

  // Loading takes seconds at best and minutes at worst, which is ample time for a second
  // click and a submitted question to both ask for a session. Handing back the in-flight
  // promise means they wait on the same one instead of building two.
  //
  // Generation-checked: an abandoned load is not handed to a new caller, or a presenter who
  // switched away from a hung Chrome create would immediately be made to wait on it again.
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

/** Stop a download in progress. Only meaningful when the provider owns the bytes; on
 *  Chrome the same slot is a re-check, so this is never wired to a button there. */
export const cancelDownload = () => {
  loadGeneration += 1;
  downloadAbort?.abort();
};

/**
 * Free the conversation.
 *
 * On LiteRT the ENGINE deliberately stays resident. It is ~2 GB of GPU memory, so freeing
 * it looks like the tidy thing to do -- but the buttons that come here are the header's
 * broom and the header bar's trash, both of which exist to be pressed MID-TALK. Reloading
 * 2 GB onto the GPU from a button whose whole purpose is to let you carry on talking would
 * make both useless. Freeing the conversation is what actually matters anyway: that is
 * where the context window lives.
 *
 * Synchronous, because `model-status.js` calls it from a click without awaiting.
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
  // The provider is the authority on what the status actually is now.
  refresh();
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

  const cheap = active.capabilities.cheapRestart;
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
    // A failed restart on Chrome leaves no usable session -- `restart()` destroys the old
    // one only after the new one resolves, but a rejection here means we cannot vouch for
    // either. Drop to a known state rather than leaving a half-live handle in place.
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

/** Delete the downloaded model. Only offered when the provider owns the bytes. */
export const deleteDownload = async () => {
  if (!active?.capabilities.canDelete) return false;
  loadGeneration += 1;
  if (chat) {
    chat.destroy();
    chat = null;
  }
  const removed = await active.remove();
  set({
    status: STATES.DOWNLOADABLE,
    elapsed: null,
    error: null,
    progress: null,
    progressText: null,
    resident: false,
    revision: state.revision + 1,
    epoch: state.epoch + 1,
  });
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
  // EVICT, not release. `release()` deliberately keeps LiteRT's engine hot for the broom,
  // but switching away means nothing will reference those ~2 GB of GPU memory again until
  // the presenter switches back -- and on a laptop mid-talk that is the difference between
  // a working deck and a swapping one.
  await previous?.evict().catch(() => {});

  active = next;
  remember(next.id);

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
  chat?.sampleContext().then(() => set({ revision: state.revision + 1 }));
};

/**
 * Live context usage.
 *
 * Synchronous because it is called in a component body. Both providers answer synchronously
 * now -- LiteRT caches an async sample behind this, Chrome reads its session directly --
 * which is why the caching that used to live here moved onto the chat handle.
 */
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
  // Real numbers from the runtime, and a far better row than the Prompt API's `params()` --
  // which was absent in Chrome 151 anyway. Omitted rather than shown as zeroes on a session
  // that has not generated yet: "0 in, 0 out · 0 tok/s" reads as a broken readout.
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
    // Offering "delete 2.0 GB" for bytes that were never fetched is a worse lie than
    // offering nothing. Derived from the status rather than asked of the provider: every
    // state except these two implies the bytes are present.
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

/**
 * Drive the machine as far as it goes without a click.
 *
 * Called at mount when the panel is open, and it STOPS at ON_DISK -- it does not create
 * anything.
 *
 * This is a deliberate reversal of what the Prompt API version did. There, warming up meant
 * promoting ON_DISK to READY so the first question streamed immediately. The same promotion
 * under LiteRT means claiming ~2 GB of GPU memory during page load, racing Spectacle's
 * 35-slide portal mount and react-spring's animations. Safari enforces per-tab memory
 * limits by KILLING THE TAB rather than throwing, so the worst case is not a slow deck, it
 * is no deck at all, before slide 1.
 *
 * The engine loads in ~1.2s from a warm cache, so the first question pays almost nothing
 * for this. A very cheap price for not gambling the talk.
 */
export const warmUp = async () => {
  await refresh();
  return state;
};

// A background download finishing is the one thing that changes status without us asking.
// Chrome fires no event for it, so its provider polls and calls this.
active?.onPromoted?.(() => {
  if (!chat) refresh();
});
