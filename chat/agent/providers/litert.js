/* global navigator:false, setTimeout:false, clearTimeout:false, DOMException:false, URL:false */
import { Backend, Engine, loadLiteRtLm } from "@litert-lm/core";
import {
  cacheAvailable,
  deleteCached,
  gb,
  getModelSource,
  isCached,
  storageRoom,
} from "./litert-cache.js";
import { STATES } from "../states.js";

/**
 * The model itself: wasm, WebGPU, engine, conversations.
 *
 * Everything above this file is provider-shaped and does not care where tokens come from.
 * This is the one module that knows about LiteRT-LM, and it exists because the Chrome
 * Prompt API could not be made to work -- see `docs/chat-handoff.md` for the measurements.
 *
 * What the swap buys, beyond having a model at all: this runs on EVERY desktop-class
 * browser. WebGPU became Baseline in January 2026, and nothing below is vendor-gated
 * beyond `navigator.gpu` -- no `SharedArrayBuffer`, so no COOP/COEP headers, which is
 * usually what stops wasm ML from working on a static host.
 *
 * Three things here are load-bearing and easy to break by tidying:
 *
 *   - `Backend.GPU_ARTISAN` is the only usable backend (see `engineFor`).
 *   - `stream()` must stay an async generator over an explicit reader (see `chatHandle`).
 *   - Generation must stay serialized (see `acquire`).
 *
 * Each is commented where it lives.
 */

/**
 * The only model we ship.
 *
 * Of the whole of HuggingFace, exactly five genuinely web-packaged `.litertlm` files exist,
 * all Gemma 4, and this is the smallest. The `-web` packaging is not cosmetic: the
 * GPU_ARTISAN backend streams the file section by section, and a plain `.litertlm` build
 * fails outright with "Streaming LlmExecutorMetadata section is not supported yet". The
 * Gemma 3 LiteRT repos are `gated: auto` and 401 without a token, so they are unusable.
 */
export const MODEL = {
  id: "gemma-4-E2B-it-web",
  label: "Gemma 4 E2B",
  repo: "litert-community/gemma-4-E2B-it-litert-lm",
  file: "gemma-4-E2B-it-web.litertlm",
  quantization: "mixed 2/4/8-bit",
};

export const MODEL_URL = `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.file}`;

/**
 * The exact size, in bytes, from the `content-length` HuggingFace serves.
 *
 * One constant, used for three things: the storage pre-check, the download progress total,
 * and -- the reason it has to be exact rather than approximate -- the integrity check that
 * stops a truncated cache entry from being handed to the engine. See `litert-cache.js`.
 */
export const MODEL_BYTES = 2008432640;

/**
 * The context window we ask for, in tokens.
 *
 * There are four different "limits" in play here and they disagree, so all four are worth
 * writing down:
 *
 *   1. The ARCHITECTURE does 128k. `google/gemma-4-E2B-it`'s config.json says
 *      `max_position_embeddings: 131072`, with a 512-token sliding window.
 *   2. The LITERT PACKAGING claims 32k -- but only in prose, in the
 *      `litert-community/gemma-4-E2B-it-litert-lm` model card. Nothing enforces it.
 *   3. The `.litertlm` FILE declares nothing. `LlmMetadata` has a `max_num_tokens` field
 *      for exactly this purpose and it is absent from this build, which is why LiteRT-LM
 *      has an open issue about being unable to report a model's real capacity. So there
 *      is no cap to hit and no way to query one -- whatever we pass is what we get.
 *   4. The RUNTIME DEFAULT, when this is left unset, is 4096.
 *
 * So the number has to come from measurement, and it did. Sweeping a deck-realistic
 * prompt (~840 tokens of preface plus a question) across candidates on an Apple GPU:
 *
 *     maxNumTokens    create    avg ttft    prefill    decode
 *          4,096      1154ms        88ms   1577 tps    72 tps
 *          8,192      1017ms        86ms   1608 tps    71 tps
 *         16,384      1016ms        83ms   1630 tps    70 tps
 *         32,768      1000ms        93ms   1438 tps    66 tps
 *         65,536      1002ms       108ms   1167 tps    60 tps
 *        131,072      1033ms       865ms     37 tps    59 tps
 *
 * Every one of them loads -- 128k included -- and engine creation is flat, because the KV
 * cache is cheap for this model: it is multi-query (one KV head) and shares KV across 20
 * of its 35 layers, leaving only three unshared global layers to scale with the window.
 * What it costs instead is DECODE THROUGHPUT, and that is the number a presenter feels.
 *
 * It also changes the ANSWERS, which is not obvious and is worth knowing before tuning
 * this. At `temperature: 0` the same prompt gives byte-identical output at 8,192 and at
 * 16,384 -- but 4,096 differs, consistently and reproducibly (two independent runs at
 * 4,096 agreed with each other 6/6 and disagreed with both larger values). So the window
 * is not a neutral allocation, and there is a threshold somewhere between 4k and 8k.
 * Above 8k it stops mattering. The 4,096 answers are not WORSE, though -- across 13
 * questions they were paraphrases, with near-identical total output and correct refusals
 * either way.
 *
 * So 8,192 is chosen on a UX argument, not a quality one: a window the conversation can
 * actually fill keeps the context underline meaningful. At 16k the meter reads ~5% all
 * night and the broom never looks necessary; at 8k a first turn shows ~14%.
 *
 * NOTE, because it is the obvious thing to assume and it is FALSE: a long conversation
 * does not degrade. The same question asked at turns 1, 7, 12, 17 and 22 returns a
 * byte-identical answer, matching a fresh conversation. History piling up costs context
 * space, and nothing else. So do not raise this hoping to fix a session that has gone
 * soft, and do not lower it hoping to prevent one.
 */
export const MAX_NUM_TOKENS = 8192;

/** Bound on tearing down an abandoned stream, so a wedged teardown cannot block the queue. */
const TEARDOWN_MS = 3000;

const abortError = () => new DOMException("Aborted", "AbortError");

/** Race a promise against a ceiling, resolving either way. Teardown must never hang. */
const bounded = async (promise, ms) => {
  let timer = null;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A WebGPU out-of-memory arrives as a THROWN ERROR, not an event, so it is only
 * distinguishable by its text. Worth keeping: it is the difference between "this machine
 * cannot run this model" and "this code is broken", and those need different responses.
 */
const isOom = (err) =>
  /out of memory|\boom\b|rangeerror|allocation failed|device.*lost/i.test(
    String(err?.message ?? err?.name ?? err),
  );

/**
 * Turn a runtime failure into something a presenter can act on.
 *
 * The two LiteRT-specific strings are worth translating because their raw form sends you
 * looking in entirely the wrong place: a "Streaming <section>" error means the model file
 * is not `-web`-packaged, and "Unsupported backend: N" means that executor was not
 * compiled into the wasm build at all. Neither is about your code.
 */
const explain = (err) => {
  if (err?.name === "AbortError") return err;
  const message = String(err?.message ?? err);
  if (isOom(err)) {
    return new Error(
      `The GPU ran out of memory loading the model. Close other tabs, or lower ` +
        `MAX_NUM_TOKENS (currently ${MAX_NUM_TOKENS}) in chat/agent/providers/litert.js. ` +
        `(${message})`,
    );
  }
  if (/Streaming .* section is not supported/i.test(message)) {
    return new Error(
      `This model file is not web-packaged, so it cannot be streamed to the GPU. ` +
        `Only "-web.litertlm" builds work. (${message})`,
    );
  }
  if (/Unsupported backend/i.test(message)) {
    return new Error(
      `The wasm build does not contain this backend. (${message})`,
    );
  }
  return err instanceof Error ? err : new Error(message);
};

/* -------------------------------------------------------------------------- */
/* The wasm module                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The wasm directory URL, DERIVED from the import map rather than pinned again.
 *
 * `@litert-lm/core` loads its wasm separately from the JS, and the two must be the same
 * version or the engine refuses to start. The reference implementation keeps a second
 * hardcoded URL next to its import map entry with a "bump both together" comment -- a rule
 * that depends on someone remembering it. Deriving instead means the version cannot drift,
 * and this repo keeps its claim that the import map IS the lockfile (see
 * `docs/dependencies.md`).
 *
 * `import.meta.resolve` shipped in Chrome 105, Firefox 106 and Safari 16.4, all far older
 * than any browser with WebGPU -- so every browser that can run this at all has it, and
 * there is no fallback to write.
 *
 * The one thing this couples to is jsDelivr's URL LAYOUT: `+esm` is served at the package
 * root, and so is `wasm/`, so `./wasm` resolves correctly. Point the import map at a
 * different CDN or at a `/dist/index.mjs`-style path and the derivation would silently be
 * wrong -- hence the assertion rather than a bare `new URL`.
 */
let wasmUrlCache = null;

export const wasmUrl = () => {
  if (wasmUrlCache) return wasmUrlCache;
  let resolved;
  try {
    resolved = import.meta.resolve("@litert-lm/core");
  } catch (err) {
    throw new Error(
      `No import map entry for "@litert-lm/core" -- add it to index.html. (${err.message})`,
    );
  }
  if (!resolved.includes("@litert-lm/core@")) {
    throw new Error(
      `Cannot derive the wasm URL from "${resolved}": it does not look like a versioned ` +
        "jsDelivr path. Update wasmUrl() in chat/agent/providers/litert.js to match.",
    );
  }
  wasmUrlCache = new URL("./wasm", resolved).href;
  return wasmUrlCache;
};

/**
 * The wasm module is a singleton for the whole page -- `loadLiteRtLm()` throws if called
 * twice. Nulled on failure so a retry is possible, and wrapping ONLY `loadLiteRtLm` is
 * deliberate: widen this and a retry hits "already loaded" instead of retrying.
 */
let wasmPromise = null;

const ensureWasm = () => {
  if (!wasmPromise) {
    wasmPromise = loadLiteRtLm(wasmUrl()).catch((err) => {
      wasmPromise = null;
      throw err;
    });
  }
  return wasmPromise;
};

/* -------------------------------------------------------------------------- */
/* WebGPU                                                                    */
/* -------------------------------------------------------------------------- */

let probeCache = null;

/**
 * Can this browser run the model at all?
 *
 * Deliberately a SMALL gate. Everything it does not check is discovered by
 * `Engine.create()` throwing a real message, which is more useful than a guess made here.
 *
 * Two things it must NOT check, both of which look reasonable and are wrong:
 *
 *   - `maxBufferSize`. GPU_ARTISAN streams the model section by section, so no single
 *     buffer ever holds 2 GB. WebGPU's DEFAULT limit is 256 MiB, so a gate framed as
 *     "enough for the weights" rejects every conformant device on earth.
 *   - `navigator.deviceMemory`. Chromium-only, so gating on it silently rejects Safari and
 *     Firefox -- the exact outcome this whole change exists to avoid.
 */
export const probe = async () => {
  if (probeCache) return probeCache;

  if (!globalThis.isSecureContext) {
    // Not pedantry: presenting from a LAN IP rather than localhost is a normal thing to do,
    // and `navigator.gpu` is simply absent there. Saying so beats "WebGPU unavailable".
    probeCache = {
      ok: false,
      supported: false,
      reason: "WebGPU needs a secure context (https, or localhost).",
    };
    return probeCache;
  }
  if (!navigator.gpu) {
    probeCache = {
      ok: false,
      supported: false,
      reason: "This browser does not support WebGPU.",
    };
    return probeCache;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      probeCache = {
        ok: false,
        supported: true,
        reason: "WebGPU is present but no GPU adapter is available.",
      };
      return probeCache;
    }
    // `adapter.info` is absent on older Safari, and an undefined `isFallbackAdapter` must
    // read as "not a fallback" rather than as a reason to refuse.
    const info = adapter.info ?? {};
    if (info.isFallbackAdapter === true) {
      probeCache = {
        ok: false,
        supported: true,
        reason:
          "Only a software fallback GPU is available, which is too slow to use.",
      };
      return probeCache;
    }
    probeCache = {
      ok: true,
      supported: true,
      reason: null,
      adapter: {
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        device: info.device || null,
        // Recorded rather than required. If GPU_ARTISAN ever fails on a browser whose
        // WebGPU is otherwise fine, this is the first thing worth looking at, and having
        // it in the info modal turns that into a glance instead of an investigation.
        shaderF16: Boolean(adapter.features?.has?.("shader-f16")),
      },
    };
    return probeCache;
  } catch (err) {
    probeCache = {
      ok: false,
      supported: true,
      reason: `Could not query the GPU: ${err.message}`,
    };
    return probeCache;
  }
};

/* -------------------------------------------------------------------------- */
/* Serializing the executor                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One generation at a time, across every conversation.
 *
 * This has no counterpart in the reference implementation, and it is the single most
 * likely cause of a mid-talk failure without it.
 *
 * `chat/use-conversation.js` `stop()` deliberately does NOT wait for the responder: it
 * bumps a run token, keeps the partial answer, and clears `busy` immediately, so the
 * composer is usable again while the abandoned turn is still winding down. That is what
 * makes stop feel instant, and it is worth keeping. But it means a second
 * `sendMessageStreaming()` can be issued while the previous stream is still cancelling --
 * and the engine has ONE main executor, shared with the router's conversations too.
 *
 * So the lock is held for the whole of an iteration, not just its start, and released in a
 * `finally` so an abandoned generator frees it. Teardown is bounded (see `bounded`),
 * because a lock nobody releases is worse than the overlap it was preventing.
 */
let tail = Promise.resolve();

const acquire = () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const mine = tail.then(() => release);
  tail = tail.then(() => held);
  return mine;
};

/* -------------------------------------------------------------------------- */
/* The engine                                                                 */
/* -------------------------------------------------------------------------- */

let engine = null;
let enginePromise = null;

/**
 * Set when an unload races a load in flight.
 *
 * `Engine.create()` is a single call that hands back no handle until it resolves, so an
 * unload during a load has nothing to tear down -- and without this flag a ~2 GB engine
 * lands resident with nothing referencing it. Reachable in normal use: the panel's restart
 * button is clickable at any state, and an ERROR retry can overlap a late create.
 */
let evicted = false;

export const engineResident = () => Boolean(engine);

export const isModelCached = () => isCached(MODEL_URL, MODEL_BYTES);

/**
 * Download the bytes if needed, then build the engine.
 *
 * `onProgress` receives `{ phase, text, progress }` where `phase` is `"download"` or
 * `"engine"`. The phase is explicit rather than inferred because the caller MUST be able
 * to distinguish them: a percentage that keeps reading 100% through a long GPU load is
 * exactly as much of a lie as one that reads 0% through a download, and the state machine
 * above has a state for each.
 */
export const ensureEngine = async ({
  onProgress = null,
  signal = null,
} = {}) => {
  if (engine) return engine;
  if (enginePromise) return enginePromise;

  evicted = false;
  enginePromise = (async () => {
    try {
      const source = await getModelSource(MODEL_URL, {
        expectedBytes: MODEL_BYTES,
        signal,
        onProgress: (p) => onProgress?.({ phase: "download", ...p }),
      });

      onProgress?.({
        phase: "engine",
        text: "Loading onto the GPU…",
        progress: null,
      });

      // The wasm is fetched here rather than earlier so a download that the presenter
      // cancels does not also pay for it.
      await ensureWasm();

      const created = await Engine.create({
        model: source,
        // Do not change this. GPU_ARTISAN is the only backend the web wasm actually
        // implements for GPU work, and it is bound to the streaming loader -- which is why
        // the model has to be a `-web` build. `Backend.GPU` is an enum entry with no
        // compiled executor and CRASHES THE TAB rather than erroring. `CPU_ARTISAN` is not
        // in the web build at all. `CPU` works but copies the whole model into the wasm
        // heap first, which is impossible at 2 GB.
        backend: Backend.GPU_ARTISAN,
        // Enables getBenchmarkInfo(), which is where the real prefill/decode token counts
        // come from -- and the honest replacement for the Prompt API's `params()` row.
        benchmarkEnabled: true,
        mainExecutorSettings: { maxNumTokens: MAX_NUM_TOKENS },
      });

      if (evicted) {
        await created.delete().catch(() => {});
        throw abortError();
      }

      engine = created;
      enginePromise = null;
      return engine;
    } catch (err) {
      // Cleared so a failed load can be retried rather than replaying its own rejection.
      enginePromise = null;
      engine = null;
      throw explain(err);
    }
  })();

  return enginePromise;
};

/**
 * Free the engine: GPU memory and wasm state, but not the bytes on disk.
 *
 * Note that the panel's unload does NOT come here -- it frees the conversation and leaves
 * the engine hot, because the alternative is a tens-of-seconds GPU reload from a button
 * whose whole purpose is to be pressed mid-talk. This is for deleting the model.
 */
export const unloadEngine = async () => {
  evicted = true; // tells an in-flight create that its rejection is an eviction, not a crash
  const current = engine;
  engine = null;
  enginePromise = null;
  try {
    await current?.delete();
  } catch {
    // Tearing down mid-load can throw; the memory is freed either way.
  }
};

/** Unload, then drop the bytes. The affordance the Prompt API could not offer at all. */
export const deleteModel = async () => {
  await unloadEngine();
  return deleteCached(MODEL_URL);
};

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A conversation, seeded with a preface.
 *
 * `createConversation` measures at ~2ms even with several turns of history in the preface,
 * because the preface is prefilled LAZILY -- `getTokenCount()` reads 0 until the first
 * generation. That single measured fact is what makes the self-healing below affordable,
 * and it is why nothing here bothers to cache or clone conversations.
 */
const newConversation = (
  system,
  pinned,
  history,
  { temperature, maxOutputTokens },
) =>
  engine.createConversation({
    // Gemma has no true system role, so the runtime folds the preface into its prompt
    // template. That works, but it does mean an instruction here binds a little less
    // firmly than the same words did as a Prompt API `initialPrompts` system message.
    //
    // THREE REGIONS, IN THIS ORDER, and the middle one is the point. `pinned` holds
    // deck context -- a slide's text, sent the first time a question is asked from
    // it. It sits OUTSIDE `history` because history is trimmed to
    // `MAX_HISTORY_MESSAGES` and this must not be: a slide pinned six messages ago
    // is still a slide a later turn may say the model has already been shown, and
    // trimming it away turns that into a reference to nothing.
    preface: {
      messages: [{ role: "system", content: system }, ...pinned, ...history],
    },
    sessionConfig: {
      samplerParams: { temperature },
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    },
  });

/**
 * The one place that reads a `Conversation`'s stream.
 *
 * Shared by the durable chat and by one-shot `generate()` calls so that the lock, the
 * teardown and the Safari reader loop exist exactly once. `prepare` runs AFTER the lock is
 * taken and returns the conversation to use -- which is what lets the chat heal itself, and
 * `generate()` build a throwaway conversation, without either racing a live generation.
 *
 * IT MUST STAY AN ASYNC GENERATOR, and it must read with an explicit reader.
 *
 * `sendMessageStreaming` returns a ReadableStream, and Safari does not implement async
 * iteration on those -- there is no `Symbol.asyncIterator`, so `for await` throws. The
 * consumer in `session.js` DOES use `for await`, and that is only legal because what it gets
 * from here is a generator, which has one by construction. So never "simplify" this into
 * `return conversation.sendMessageStreaming(text)`: Chrome would stay green and Safari would
 * break, silently, in the one configuration nobody checks before walking on stage.
 *
 * Yields DELTAS. `chat/agent/session.js` accumulates them and hands the accumulated string
 * onward, so a dropped or reordered chunk cannot desync the display.
 */
async function* streamFrom({ text, signal = null, prepare, onCancel = null }) {
  const release = await acquire();
  let conversation = null;
  let reader = null;
  let drained = false;

  const cancel = () => {
    // The ONLY cancellation LiteRT offers -- there is no AbortSignal support anywhere in the
    // API, so an abort that does not reach this call does nothing at all: generation
    // continues, burning the GPU, until it finishes on its own.
    if (!conversation) return;
    onCancel?.();
    try {
      conversation.cancel();
    } catch {
      /* nothing in flight */
    }
  };

  try {
    if (signal?.aborted) throw abortError();
    conversation = await prepare();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener("abort", cancel, { once: true });

    reader = conversation.sendMessageStreaming(text).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      // A chunk's `content` is an array of parts; only text exists on the web today.
      let delta = "";
      for (const part of value?.content ?? []) {
        if (part.type === "text" && part.text) delta += part.text;
      }
      // Skip empty chunks. Not merely an optimisation: an empty yield rearms the idle
      // timeout in `session.js`, so a model emitting nothing forever would never trip it.
      if (delta) yield delta;
    }
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw explain(err);
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (reader) {
      // Cancel the conversation FIRST while the stream is still live, or it keeps decoding
      // into a reader nobody is draining. This block runs for an abandoned generator too:
      // breaking out of `for await` calls `.return()`.
      if (!drained) {
        cancel();
        await bounded(
          reader.cancel().catch(() => {}),
          TEARDOWN_MS,
        );
      }
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    release();
  }
}

/*
 * There was a `generate()` here: one complete answer from a throwaway conversation, for the
 * router and the edit planner, which needed a whole string rather than a stream and must not
 * pollute the chat's history. Both are gone, so it had no callers left.
 *
 * If a non-streaming call comes back, note what it cost on the other provider: Chrome has no
 * throwaway session, so the same call meant a full `create()` -- measured at ~9.5s -- before
 * every answer. A router that runs per turn is affordable here and is not there.
 */

/**
 * The durable chat session.
 *
 * WE own the transcript; the `Conversation` is disposable and rebuilt every turn. That is
 * the opposite of the obvious design -- a `Conversation` keeps its own history and could
 * simply be talked to -- and it is worth explaining, because it fixes a serious measured
 * failure and dissolves two others.
 *
 * THE FAILURE. Every answer turn sends retrieved slide text with the question: ~700-1500
 * characters of DECK EXCERPTS, rebuilt per turn because it depends on the question. Let the
 * conversation keep those and by the third turn its history holds several excerpt blocks,
 * and a 2B model starts answering the accumulated soup instead of what was asked. Measured
 * on five code questions: 2 of 5 usable when they accumulated, 5 of 5 when each ran on a
 * fresh conversation, with context climbing 0 -> 1364 -> 1764 -> 2673 -> 4338 tokens.
 * The answers did not degrade gently, they degenerated into "please provide the context".
 *
 * THE FIX. `stream()` takes what to SEND and, separately, what to REMEMBER. The excerpts
 * are sent and then dropped; only the bare question and the answer go into the transcript.
 * Each turn rebuilds a conversation from that transcript, which costs ~2ms plus prefill of
 * a few hundred tokens at ~1600 tokens/sec.
 *
 * WHAT IT DISSOLVES. Rebuilding every turn means a cancelled conversation is never reused,
 * so the `cancel()` poisoning that used to need a whole heal-on-next-turn mechanism is now
 * simply irrelevant -- the poisoned object is thrown away. (The poisoning is real and worth
 * remembering: one `cancel()`, from any cause, and every later `sendMessageStreaming` on
 * that conversation rejects with "Task cancelled". It never recovers, and `clone()` inherits
 * it AND loses the history.) It also means "clear the context" is a transcript reset rather
 * than an engine concern.
 *
 * The transcript is BOUNDED. Prefill is re-paid each turn, so an unbounded one would make
 * every turn slower than the last; `MAX_TURNS` keeps that flat while leaving enough room for
 * "tell me more" to mean something.
 */

/** Exchanges kept for continuity. 6 messages = 3 question/answer pairs. */
const MAX_HISTORY_MESSAGES = 6;

export const createChat = async ({ system, temperature = 0.7 }) => {
  await ensureEngine();

  /** The transcript WE keep. The `Conversation` is disposable; this is not. */
  let transcript = [];

  /**
   * Deck context already handed to the model, in the order it was sent.
   *
   * APPEND-ONLY AND NEVER TRIMMED, which is the one way it differs from
   * `transcript`. `chat/agent/deck-context.js` guarantees a slide is offered here
   * at most once, so this grows with distinct slides asked about rather than with
   * turns -- bounded by the deck at 35 blocks, and five to a dozen in a real talk.
   * It is exactly what the removed `remember` option could not express: that
   * option existed to keep per-turn excerpts OUT of the model's memory, and this
   * one exists to keep them in it, once.
   */
  let pinned = [];

  let conversation = await newConversation(system, [], [], { temperature });

  /** Last sampled token count, and the one-at-a-time guard for sampling it. */
  let tokens = 0;
  let sampling = false;

  const rebuild = async () => {
    const dead = conversation;
    conversation = await newConversation(system, pinned, transcript, {
      temperature,
    });
    try {
      dead.cancel();
    } catch {
      /* nothing in flight */
    }
    dead.delete().catch(() => {});
  };

  const session = {
    /** For diagnostics and tests. Nothing above this module should reach through it. */
    get raw() {
      return conversation;
    },

    /**
     * Stream one turn.
     *
     * `pin` is a slide's text, the first time a question comes from that slide. It
     * goes into `pinned` rather than into `text`, so it survives history trimming
     * and the transcript keeps the question the user actually typed.
     *
     * `note` is where the deck is right now, and it goes the OTHER way -- prepended
     * to the sent string and deliberately left out of the transcript, so it is gone
     * next turn. That asymmetry is the point: a position line is false as soon as
     * the deck moves, and pinning one put it in the preface, far above the exchange
     * it was about. The model then answered about the previous slide.
     *
     * `note` is therefore exactly the removed `remember` seam, restored for the one
     * thing it was right for; `pin` is its opposite and is new. The old option sent
     * excerpts and kept only the question. This sends the question, keeps the slide,
     * and drops the position.
     */
    async *stream(
      text,
      { pin = "", note = "", signal = null, onPrompt = null } = {},
    ) {
      let answer = "";
      try {
        for await (const delta of streamFrom({
          // What is SENT. `text` alone is what gets remembered, below.
          text: note ? `${note}\n\n${text}` : text,
          signal,
          // Inside the lock, so the rebuild can never race a live generation.
          prepare: async () => {
            // Pinned BEFORE the rebuild, so this turn's conversation is built with
            // the slide already in its preface -- the question that triggered the
            // pin is the first question that gets to use it.
            if (pin) pinned.push({ role: "user", content: pin });
            await rebuild();
            // Reported from here, after the rebuild that consumed it, because THIS
            // is the preface the conversation was actually built from -- not what
            // the UI transcript happens to hold. The two diverge by design: this
            // one is trimmed to `MAX_HISTORY_MESSAGES` and the panel's is not.
            //
            // Copied, not passed by reference. `transcript` is reassigned by the
            // slice below on the very next turn, and a caller keeping this around
            // to show later must see what was sent, not what is current.
            onPrompt?.({
              provider: "litert",
              system,
              pinned: pinned.map((message) => ({ ...message })),
              history: transcript.map((message) => ({ ...message })),
              // What was SENT, note and all -- the viewer's job is to show what
              // actually went, not the tidier thing the transcript will keep.
              message: note ? `${note}\n\n${text}` : text,
              historyLimit: MAX_HISTORY_MESSAGES,
            });
            return conversation;
          },
        })) {
          answer += delta;
          yield delta;
        }
      } finally {
        // Recorded even on abort: the presenter saw a partial answer and the transcript
        // should match what is on screen. Trimmed from the front, in pairs.
        //
        // BARE `text`, not the sent string: `note` is deliberately dropped here. That
        // is the whole of the restored `remember` behaviour -- a position line is true
        // for one turn, and a transcript accumulating five contradictory ones is the
        // accumulation failure in miniature.
        transcript.push(
          { role: "user", content: text },
          { role: "assistant", content: answer },
        );
        if (transcript.length > MAX_HISTORY_MESSAGES) {
          transcript = transcript.slice(-MAX_HISTORY_MESSAGES);
        }
      }
    },

    /**
     * Live context occupancy: preface plus every turn so far.
     *
     * SYNCHRONOUS, because `model-status.js` reads it in a component body. LiteRT's
     * `getTokenCount()` is async, so the number is cached here and refreshed out of band by
     * `sampleContext()`. This pair used to live in `model-state.js` as a module-level
     * `lastTokens` plus a `sampling` guard; it belongs on the handle, because it is the
     * single largest difference between the two providers -- Chrome reads `inputUsage` and
     * `inputQuota` straight off its session and has nothing to sample.
     *
     * Reads 0 until the first generation, because the preface prefills lazily. That is not
     * a bug to paper over -- nothing has been spent yet, so 0 is the honest number.
     */
    context() {
      if (tokens == null) return null;
      return {
        used: tokens,
        total: MAX_NUM_TOKENS,
        pct: Math.round((tokens / MAX_NUM_TOKENS) * 100),
      };
    },

    /** Refresh what `context()` returns. At most one in flight; failures leave the last
     *  good number rather than blanking the meter. */
    async sampleContext() {
      if (sampling) return;
      sampling = true;
      try {
        const n = await conversation.getTokenCount();
        if (n != null) tokens = n;
      } catch {
        // Keep the previous reading.
      } finally {
        sampling = false;
      }
    },

    /** The last turn's real prefill/decode counts, for the info modal. */
    async benchmark() {
      try {
        return await conversation.getBenchmarkInfo();
      } catch {
        // GPU_ARTISAN logs "GetProfileSummary not implemented for backend: GpuArtisan",
        // which costs only the tokens/sec rates -- the counts themselves are populated.
        return null;
      }
    },

    /**
     * Empty the context window and keep talking. The broom, not the trash.
     *
     * Now a transcript reset first and a conversation rebuild second -- dropping the
     * transcript is what actually clears the context, since the next turn rebuilds from it.
     * Mutates in place, so every reference to the session stays valid; an earlier version
     * returned a new handle and the second restart had nothing to call.
     *
     * `pinned` MUST BE CLEARED WITH IT, and this is not optional bookkeeping. Every
     * caller of `restart()` bumps `epoch`, and `deck-context.js` clears its seen-set
     * from `epoch` -- so a `pinned` that survived would meet a policy that has
     * forgotten those slides and offers them again, putting two copies of the same
     * slide in one preface. Duplicate blocks are the precise failure
     * `chat-handoff.md` §6 measured. The two structures track the same fact and
     * therefore reset on the same signal.
     */
    async restart() {
      transcript = [];
      pinned = [];
      tokens = 0;
      await rebuild();
      return session;
    },

    destroy() {
      transcript = [];
      pinned = [];
      tokens = null;
      try {
        conversation.cancel();
      } catch {
        /* nothing in flight */
      }
      // Async, deliberately not awaited: the caller is a synchronous `unload()` wired to a
      // click, and the GPU memory is freed either way.
      conversation.delete().catch(() => {});
    },
  };

  return session;
};

/* -------------------------------------------------------------------------- */
/* The provider face                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything above, as the shape `model-state.js` drives. See `providers/index.js` for the
 * contract and for the table of where the two providers disagree.
 *
 * Deliberately a thin adaptor appended to the file rather than a restructuring of it. The
 * functions above are the measured, commented, load-bearing part; this is just the socket
 * they plug into, and keeping the seam obvious means a future reader can tell which is
 * which.
 */
export const provider = {
  id: "litert",
  label: "Gemma",

  capabilities: {
    // We fetched the bytes, so progress is real and cancel is a real abort.
    ownsBytes: true,
    canDelete: true,
    downloadBytes: MODEL_BYTES,
    // Our state is a FACT: we own the download and the engine, so nothing changes behind
    // our back. `session.js` reads this before deciding whether to trust a DOWNLOADING
    // reading enough to refuse a question on it.
    authoritativeStatus: true,
    // ~2ms, because the engine stays hot and a new conversation prefills its preface
    // lazily. This is what lets the broom be a button rather than a spinner.
    cheapRestart: true,
  },

  timings: {
    stallMs: 60000,
    // A WEDGE DETECTOR, not a performance budget. Measured at 3.0s cold and 1.2s from a warm
    // cache, so this is two orders of magnitude above anything observed and only fires when
    // something is genuinely stuck.
    createCeilingMs: 120000,
  },

  /** Only the labels that differ from the base table. */
  stateMeta: {
    [STATES.UNSUPPORTED]: { title: "This browser can't run WebGPU" },
    [STATES.UNAVAILABLE]: { title: "This device's GPU can't run the model" },
    [STATES.DOWNLOADABLE]: {
      // The size is in the label because this click starts a multi-gigabyte fetch. A
      // presenter who triggers that unknowingly on venue wifi has a genuine problem, and
      // "click to download" alone does not warn anybody.
      title: `Model not downloaded — click to fetch it (${gb(MODEL_BYTES)} GB)`,
    },
    // Clickable, and it does something real -- this download is ours to stop.
    [STATES.DOWNLOADING]: {
      title: "Downloading the model… (click to stop)",
      action: "cancel",
    },
    [STATES.CREATING]: { title: "Loading the model onto the GPU…" },
    // The engine stays hot deliberately -- see `release()`.
    [STATES.READY]: { title: "Session live — click to free the conversation" },
  },

  /** Always offered, even where it cannot run: it is the deck's story, and
   *  `unavailableCopy()` says more about a refusal than an absent pill would. */
  offered: () => true,

  probe,

  async status() {
    const gpu = await probe();
    if (!gpu.supported) return STATES.UNSUPPORTED;
    if (!gpu.ok) return STATES.UNAVAILABLE;
    return (await isModelCached()) ? STATES.ON_DISK : STATES.DOWNLOADABLE;
  },

  async acquire({ system, signal, onPhase }) {
    await ensureEngine({ signal, onProgress: onPhase });
    return createChat({ system });
  },

  /**
   * Free the conversation and KEEP THE ENGINE HOT.
   *
   * Freeing ~2 GB of GPU memory looks like the tidy thing to do, but the buttons that come
   * here exist to be pressed mid-talk. Reloading the engine from a control whose whole
   * purpose is to let you carry on talking would make it useless. The conversation is what
   * matters anyway: that is where the context window lives.
   */
  release: () => {},

  evict: () => unloadEngine(),
  remove: () => deleteModel(),
  resident: engineResident,

  async info() {
    const gpu = await probe();
    const adapter = gpu.adapter;
    const cached = await isModelCached().catch(() => false);
    const storage = await storageRoom(MODEL_BYTES).catch(() => null);

    let wasm;
    try {
      wasm = wasmUrl();
    } catch (err) {
      wasm = `unresolved: ${err.message}`;
    }

    return [
      ["Model", `${MODEL.label} · ${MODEL.quantization}`],
      ["File", `${MODEL.file} (${gb(MODEL_BYTES)} GB)`],
      ["Backend", "GPU_ARTISAN · WebGPU"],
      [
        "GPU",
        adapter
          ? [adapter.vendor, adapter.architecture].filter(Boolean).join(" ") ||
            "available"
          : (gpu.reason ?? "—"),
      ],
      ["shader-f16", adapter ? (adapter.shaderF16 ? "yes" : "no") : "—"],
      [
        "Downloaded",
        cached
          ? "yes, verified complete"
          : cacheAvailable
            ? "no"
            : "no (this browser has no Cache API)",
      ],
      ["Engine", engineResident() ? "loaded on the GPU" : "not loaded"],
      ...(storage?.quota
        ? [
            [
              "Storage",
              `${(storage.free / 1e9).toFixed(1)} GB free of ` +
                `${(storage.quota / 1e9).toFixed(1)} GB`,
            ],
          ]
        : []),
      ["wasm", wasm],
    ];
  },

  unavailableCopy: () => ({
    lead: "This deck's model runs on your GPU through WebGPU, and this browser or device can't provide one.",
    bullets: [
      "WebGPU needs a secure context — https, or localhost. A LAN IP will not do.",
      "Safari 18+, Chrome 113+ and Firefox 141+ all ship WebGPU on desktop.",
      "A software fallback adapter is refused on purpose: it is too slow to be usable.",
    ],
  }),
};
