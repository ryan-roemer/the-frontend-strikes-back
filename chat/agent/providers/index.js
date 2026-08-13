/* global localStorage:false */
import { provider as litert } from "./litert.js";
import { provider as chrome } from "./chrome.js";

/**
 * The two on-device providers, and the contract they both satisfy.
 *
 * This is the whole point of the deck's assistant: the same panel, the same transcript and
 * the same state machine, driven by two runtimes that disagree about almost everything. The
 * interesting part is not that they can be abstracted -- it is WHERE the abstraction leaks,
 * because that is the actual story about on-device AI in a browser today.
 *
 *   ------------------------  ----------------------------  ----------------------------
 *                             LiteRT.js / Gemma 4 E2B       Chrome Prompt API
 *   ------------------------  ----------------------------  ----------------------------
 *   who owns the bytes        the page                      the browser
 *   download progress         real, in bytes                a number the browser reports
 *   cancel a download         yes, it is our `fetch`        no
 *   delete the model          yes, it is our Cache entry    no -- chrome://on-device-internals
 *   status is a fact          yes                           NO. `availability()` flaps.
 *   requires WebGPU           yes, and a non-fallback GPU   not our problem
 *   a throwaway session       ~2ms                          a full `create()`, ~9.5s
 *   ------------------------  ----------------------------  ----------------------------
 *
 * THE PROVIDER INTERFACE. Each module exports one `provider` object:
 *
 *   id            "litert" | "chrome"
 *   label         what the switcher pill says
 *   capabilities  { ownsBytes, canDelete, downloadBytes, authoritativeStatus, cheapRestart }
 *   timings       { stallMs, createCeilingMs } -- see the note on `createCeilingMs` below
 *   stateMeta     PARTIAL overrides, merged over BASE_STATE_META in model-state.js
 *   offered()     boolean, sync. False hides it from the switcher entirely.
 *   probe()       -> { ok, supported, reason, adapter? }
 *   status()      -> Promise<STATES.*>. MUST NOT create or download anything.
 *   acquire({ system, signal, onPhase })  -> Promise<Chat>. Download + create, one call.
 *   release()     drop the conversation; keep whatever is expensive and cheap to keep
 *   evict()       drop EVERYTHING held in memory. Called on a provider switch.
 *   remove()      delete the bytes. Absent when `capabilities.canDelete` is false.
 *   resident()    boolean -- is anything expensive currently held?
 *   info()        -> Promise<Array<[label, value]>> for the info modal
 *   unavailableCopy(status) -> { lead, bullets[] }
 *
 * THE CHAT HANDLE that `acquire()` resolves to:
 *
 *   stream(text, { signal })  async generator over DELTAS. Must be a GENERATOR -- Safari has
 *                             no `Symbol.asyncIterator` on ReadableStream and `session.js`
 *                             uses `for await`.
 *   context()                 SYNC { used, total, pct } | null. Called in a component body.
 *   sampleContext()           Promise. Refreshes what `context()` returns; may be a no-op.
 *   restart()                 Promise. Empty the context window, keep talking.
 *   destroy()                 SYNC. Called from a click handler without awaiting.
 *   benchmark()               Promise<object|null>. Optional detail for the info modal.
 *
 * `onPhase` receives `{ phase, text, progress }` with `phase` of `"download"` or `"engine"`.
 * The phase is explicit rather than inferred because BOTH providers have lied here in
 * opposite directions: Chrome fires a download event with `loaded: 0` for a model already on
 * disk, and LiteRT reports a cache hit as progress 1. A percentage that reads 0% through a
 * download and one that reads 100% through a GPU load are the same bug.
 *
 * `createCeilingMs` means opposite things per provider and that is deliberate, not sloppy.
 * On LiteRT it is a wedge detector on a phase measured at 1-3s. On Chrome it is a bail-out
 * on a phase that legitimately takes minutes, because `create()` secretly blocks on a
 * download it will not tell you about. Same field, two reasons -- both are commented at
 * their definitions.
 */

/** Registration order is display order in the switcher. */
const ALL = [chrome, litert];

export const byId = (id) => ALL.find((p) => p.id === id) ?? null;

/**
 * The providers worth showing.
 *
 * LiteRT is ALWAYS offered, even on a machine that cannot run it -- it is the deck's story,
 * and `unavailableCopy()` explains the refusal far better than a missing button does.
 * Chrome is offered only when the global exists, because a pill for an API this browser has
 * never heard of is noise rather than information.
 */
export const offered = () => ALL.filter((p) => p.offered());

const STORAGE_KEY = "chat:provider";

/**
 * Which provider to start with.
 *
 * Prefers whatever was last chosen EXPLICITLY, then Chrome, then LiteRT. Preferring Chrome
 * looks reckless given how badly it has been measured to behave (see `chrome.js`), and it
 * would be if selecting a provider loaded it. It does not: `warmUp()` stops at ON_DISK and
 * never builds anything, so this choice costs one `availability()` call on page load. The
 * zero-download option is the right default when picking it is free.
 *
 * Falls back rather than throwing if the stored id is stale -- a provider can stop being
 * offered between reloads (a different browser, a flag turned off), and a deck that refuses
 * to boot because of a localStorage key from last week is a deck that fails on stage.
 */
export const pick = () => {
  const available = offered();
  if (!available.length) return null;

  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Safari in private mode throws on access, not just on write.
  }
  const remembered = available.find((p) => p.id === stored);
  if (remembered) return remembered;

  return available.find((p) => p.id === "chrome") ?? available[0];
};

/** Written only on an explicit switch, never on the fallback path -- otherwise the first
 *  load on a Chrome-less browser would silently pin the choice to LiteRT forever. */
export const remember = (id) => {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not worth surfacing: the panel works, it just will not remember.
  }
};
