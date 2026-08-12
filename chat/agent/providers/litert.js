/* global navigator:false, setTimeout:false, clearTimeout:false, DOMException:false, URL:false */
import { Backend, Engine, loadLiteRtLm } from "@litert-lm/core";
import { getModelSource, isCached, deleteCached } from "./litert-cache.js";

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
const newConversation = (system, history, { temperature, maxOutputTokens }) =>
  engine.createConversation({
    // Gemma has no true system role, so the runtime folds the preface into its prompt
    // template. That works, but it does mean an instruction here binds a little less
    // firmly than the same words did as a Prompt API `initialPrompts` system message.
    preface: {
      messages: [{ role: "system", content: system }, ...history],
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

/**
 * One complete answer from a throwaway conversation.
 *
 * For the router and the edit planner, which need a whole string rather than a stream, and
 * which must not pollute the chat's history. The conversation is destroyed in a `finally`
 * even when the caller aborts -- each one holds KV cache, and leaking twenty of them over a
 * talk is GPU memory we do not have.
 *
 * `temperature: 0` by default. For classification and for filling in a schema, determinism
 * is worth much more than variety, and it is the cheapest accuracy available.
 */
export const generate = async ({
  system,
  message,
  maxOutputTokens = 64,
  temperature = 0,
  signal = null,
}) => {
  await ensureEngine();
  let conversation = null;
  let out = "";
  try {
    for await (const delta of streamFrom({
      text: message,
      signal,
      prepare: async () => {
        conversation = await newConversation(system, [], {
          temperature,
          maxOutputTokens,
        });
        return conversation;
      },
    })) {
      out += delta;
    }
    return out;
  } finally {
    if (conversation) {
      try {
        conversation.cancel();
      } catch {
        /* nothing in flight */
      }
      conversation.delete().catch(() => {});
    }
  }
};

/**
 * The durable chat session.
 *
 * Returned as a mutable object that owns the CURRENT conversation rather than as a wrapper
 * around one, because a conversation here is disposable and gets replaced underneath the
 * caller. Two reasons it has to be replaced, one obvious and one measured:
 *
 * A `Conversation` owns its own history, so there is nothing to "clear in place" -- the
 * only way to empty a context window is to build another one. That was equally true of a
 * Prompt API session, and it is why the panel has a restart button at all.
 *
 * AND: `cancel()` PERMANENTLY POISONS A CONVERSATION. Measured -- one cancel, from any
 * cause, and every later `sendMessageStreaming` on it rejects with "Task cancelled". It
 * does not recover with time, and `clone()` inherits the poison AND loses the history
 * (a clone of a cancelled conversation reports 0 tokens). If you find that familiar, it is
 * almost exactly the Chrome 151 bug this deck already documents in `planner.js`, where a
 * second constrained prompt fails with `kErrorUnknown` and `clone()` is tainted too.
 * Different API, same shape.
 *
 * That would make the stop button a one-shot -- press it once and the assistant is mute
 * for the rest of the talk. What saves it is that a cancelled conversation is still
 * READABLE: `getHistory()` and `getTokenCount()` both work. So a poisoned conversation is
 * replaced with a fresh one carrying its history forward as the preface, which is verified
 * to preserve context (a replacement still recalls a fact from before the cancel, where a
 * control conversation with no history does not) and costs ~2ms.
 *
 * The healing is LAZY -- deferred to the next `stream()`, inside the lock. Doing it eagerly
 * in the abort path would race the generation that is still unwinding.
 */
export const createChat = async ({ system, temperature = 0.7 }) => {
  await ensureEngine();

  let conversation = await newConversation(system, [], { temperature });
  /** Set when `cancel()` has been called, so this conversation can no longer generate. */
  let poisoned = false;

  /** Rebuild from the poisoned conversation's history. Called only while holding the lock. */
  const heal = async () => {
    let history = [];
    try {
      history = await conversation.getHistory();
    } catch {
      // Unreadable as well as unusable: start clean rather than fail. Losing the thread is
      // survivable; refusing to answer is not.
    }
    const dead = conversation;
    conversation = await newConversation(system, history, { temperature });
    poisoned = false;
    dead.delete().catch(() => {});
  };

  const session = {
    /** For diagnostics and tests. Nothing above this module should reach through it. */
    get raw() {
      return conversation;
    },

    /** Streams deltas. See `streamFrom` for the lock, the teardown and the Safari rule. */
    stream(text, { signal = null } = {}) {
      return streamFrom({
        text,
        signal,
        // Runs inside the lock, so healing can never race a live generation.
        prepare: async () => {
          if (poisoned) await heal();
          return conversation;
        },
        onCancel: () => {
          poisoned = true;
        },
      });
    },

    /**
     * Whole-conversation occupancy: preface plus every turn so far.
     *
     * Reads 0 until the first generation, because the preface prefills lazily. That is not
     * a bug to paper over -- nothing has been spent yet, so 0 is the honest number.
     */
    async tokenCount() {
      try {
        return await conversation.getTokenCount();
      } catch {
        return null;
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
     * Mutates in place, so every reference to the session stays valid -- an earlier version
     * returned a new handle, and the second restart then had nothing to call.
     */
    async restart() {
      const dead = conversation;
      conversation = await newConversation(system, [], { temperature });
      poisoned = false;
      try {
        dead.cancel();
      } catch {
        /* nothing in flight */
      }
      dead.delete().catch(() => {});
      return session;
    },

    destroy() {
      try {
        conversation.cancel();
      } catch {
        /* nothing in flight */
      }
      poisoned = true;
      // Async, deliberately not awaited: the caller is a synchronous `unload()` wired to a
      // click, and the GPU memory is freed either way.
      conversation.delete().catch(() => {});
    },
  };

  return session;
};
