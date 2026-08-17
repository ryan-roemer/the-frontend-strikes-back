import { provider as litert } from "./litert.js";
import { provider as chrome } from "./chrome.js";

/**
 * The two on-device providers, and the contract they both satisfy.
 *
 * One panel, one transcript, one state machine, over two runtimes that disagree about
 * almost everything. WHERE THE ABSTRACTION LEAKS is the useful part:
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
 *   timings       { stallMs, createCeilingMs }
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
 *   stream(text, { pin, note, signal, onPrompt })
 *                 Async generator over DELTAS. MUST be a generator: Safari has no
 *                 `Symbol.asyncIterator` on ReadableStream and `session.js` uses
 *                 `for await`.
 *   context()     SYNC { used, total, pct } | null.
 *   sampleContext()  Promise. Refreshes what `context()` returns; may be a no-op.
 *   restart()     Promise. Empty the context window, keep talking.
 *   destroy()     SYNC. Called from a click handler without awaiting.
 *   benchmark()   Promise<object|null>. Optional detail for the info modal.
 *
 * `pin` AND `note` ARE TWO ARGUMENTS BECAUSE THEY HAVE OPPOSITE LIFETIMES, and the lifetime
 * is the contract -- placement is the provider's business:
 *
 *   pin   sent with this turn and STILL PRESENT on every later one, without the caller
 *         re-sending it. A slide's text, offered once per slide per conversation.
 *   note  sent with this turn and GONE after it. Where the deck is, which is false as soon
 *         as it moves.
 *
 * NEITHER may be folded into `text`, which is the question the transcript bubble renders.
 * Whatever holds `pin` must be cleared wherever the transcript is -- see `restart()`, where
 * forgetting it puts two copies of a slide in one preface.
 *
 * `onPrompt` is optional, called AT MOST ONCE before the first delta, with
 * `{ provider, system, pinned, history, message, historyLimit }`. Not the final prompt:
 * both providers hand a message array to a runtime that applies the model's turn template
 * across a wasm or process boundary, so the string the model reads is never a JS value.
 * `pinned` is empty where the provider has no separate region, in which case the block is
 * already inside `message`. Implementations MUST pass a copy.
 *
 * `onPhase` receives `{ phase, text, progress }`, `phase` being `"download"` or `"engine"`.
 * EXPLICIT RATHER THAN INFERRED because both providers mislead here in opposite directions:
 * Chrome fires a download event with `loaded: 0` for a model already on disk, LiteRT
 * reports a cache hit as progress 1.
 *
 * `createCeilingMs` means opposite things per provider, deliberately: a wedge detector on
 * LiteRT's 1-3s create, a bail-out on Chrome's, which secretly blocks on a download.
 */

/** Registration order is display order in the switcher. */
const ALL = [chrome, litert];

export const byId = (id) => ALL.find((p) => p.id === id) ?? null;

/**
 * The providers worth showing. LiteRT is always offered even where it cannot run, because
 * `unavailableCopy()` explains a refusal better than a missing button; Chrome only when the
 * global exists, because a pill for an absent API is noise.
 */
export const offered = () => ALL.filter((p) => p.offered());

const STORAGE_KEY = "chat:provider";

/**
 * Which provider to start with: whatever was last chosen EXPLICITLY, then Chrome, then
 * LiteRT.
 *
 * Preferring Chrome looks reckless given how it behaves (see `chrome.js`) and would be if
 * selecting a provider loaded it. It does not -- the mount-time `refresh()` stops at
 * ON_DISK -- so this costs one `availability()` call, and the zero-download option is the
 * right default when picking it is free.
 *
 * A stale stored id falls back rather than throwing: a provider can stop being offered
 * between reloads, and a deck that will not boot because of last week's localStorage key
 * is a deck that fails on stage.
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
