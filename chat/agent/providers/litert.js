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
 * The model itself: wasm, WebGPU, engine, conversations. The one module that knows about
 * LiteRT-LM; everything above it is provider-shaped.
 *
 * Requires only `navigator.gpu` -- no `SharedArrayBuffer`, so no COOP/COEP headers, which
 * is what usually stops wasm ML from working on a static host.
 *
 * Three things are load-bearing and easy to break by tidying, each commented where it
 * lives: `Backend.GPU_ARTISAN` is the only usable backend, `stream()` must stay an async
 * generator over an explicit reader, and generation must stay serialized.
 */

/**
 * The only model we ship.
 *
 * The `-web` packaging is not cosmetic: GPU_ARTISAN streams the file section by section,
 * and a plain `.litertlm` build fails with "Streaming LlmExecutorMetadata section is not
 * supported yet". The Gemma 3 LiteRT repos are `gated: auto` and 401 without a token.
 */
export const MODEL = {
  id: "gemma-4-E2B-it-web",
  label: "Gemma 4 E2B",
  repo: "litert-community/gemma-4-E2B-it-litert-lm",
  file: "gemma-4-E2B-it-web.litertlm",
  quantization: "mixed 2/4/8-bit",
};

const MODEL_URL = `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.file}`;

/**
 * A VERSION PIN AND A FALLBACK, NOT THE INTEGRITY CHECK.
 *
 * The model is pinned by repo and filename only, so the byte count is the one signal that
 * upstream has republished the file. Used for the storage pre-check (nothing else exists
 * before bytes arrive), as the progress total when a response carries no `content-length`,
 * and for a drift warning that logs and continues.
 *
 * Truncation is checked elsewhere, against the `content-length` of the response the bytes
 * came from -- see `litert-cache.js`. Checking it against this constant instead would make
 * an upstream reupload unrecoverable: the download completes, is judged incomplete, deletes
 * itself, and fails the same way on every retry.
 */
const EXPECTED_BYTES = 2008432640;

/**
 * The context window we ask for, in tokens.
 *
 * NOTHING ENFORCES A CAP, so whatever we pass is what we get: the architecture does 128k,
 * the model card claims 32k in prose only, and the `.litertlm` build declares no
 * `max_num_tokens` at all. Left unset the runtime defaults to 4096.
 *
 * Measured on an Apple GPU, ~840 tokens of preface plus a question. Every value loads,
 * including 128k; engine creation is flat. What a larger window costs is decode:
 *
 *     maxNumTokens    create    avg ttft    prefill    decode
 *          4,096      1154ms        88ms   1577 tps    72 tps
 *          8,192      1017ms        86ms   1608 tps    71 tps
 *         16,384      1016ms        83ms   1630 tps    70 tps
 *         32,768      1000ms        93ms   1438 tps    66 tps
 *         65,536      1002ms       108ms   1167 tps    60 tps
 *        131,072      1033ms       865ms     37 tps    59 tps
 *
 * 8,192 is chosen so the context meter stays meaningful -- at 16k it reads ~5% all night
 * and the broom never looks necessary. Below 8k the window starts changing answers.
 *
 * DO NOT TUNE THIS TO FIX A SESSION THAT HAS GONE SOFT: a long conversation does not
 * degrade. The same question at turns 1, 7, 12, 17 and 22 returns byte-identical output.
 * History costs context space and nothing else.
 */
const MAX_NUM_TOKENS = 8192;

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
 * `@litert-lm/core` loads its wasm separately from its JS and the two must be the same
 * version, so deriving keeps the import map as the single pin (see `docs/dependencies.md`).
 *
 * This couples to jsDelivr's URL LAYOUT -- `+esm` and `wasm/` both sit at the package root,
 * so `./wasm` resolves. Point the import map at another CDN or a `/dist/index.mjs`-style
 * path and the derivation would silently be wrong, hence the assertion below.
 */
let wasmUrlCache = null;

const wasmUrl = () => {
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
 * Deliberately a SMALL gate -- everything it does not check is discovered by
 * `Engine.create()` throwing a real message, which beats a guess made here.
 *
 * Two things it must NOT check, both of which look reasonable and are wrong:
 *
 *   - `maxBufferSize`. GPU_ARTISAN streams the model section by section, so no single
 *     buffer ever holds 2 GB. WebGPU's default limit is 256 MiB, so a gate framed as
 *     "enough for the weights" rejects every conformant device on earth.
 *   - `navigator.deviceMemory`. Chromium-only, so gating on it rejects Safari and Firefox.
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
 * The engine has ONE main executor, and `chat/use-conversation.js` `stop()` deliberately
 * does not wait for the responder -- it clears `busy` immediately so the composer feels
 * instant. So a second `sendMessageStreaming()` can be issued while the previous stream is
 * still cancelling.
 *
 * The lock is therefore held for the whole of an iteration, not just its start, and
 * released in a `finally` so an abandoned generator frees it. Teardown is bounded (see
 * `bounded`): a lock nobody releases is worse than the overlap it was preventing.
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
 * Which engine build the module currently wants.
 *
 * `Engine.create()` hands back no handle until it resolves, so an unload during a load has
 * nothing to tear down and a ~2 GB engine can land resident with nothing referencing it.
 * Reachable in normal use: the restart button is clickable at any state, and an ERROR retry
 * can overlap a late create.
 *
 * A COUNTER, NOT A BOOLEAN. A flag reset at the top of `ensureEngine` is cleared by the
 * second create before the first resolves, so the first installs itself over the second and
 * both stay resident -- and on the failure path the first would clear the second's
 * `enginePromise`. Same mechanism as `model-state.js`'s `loadGeneration` one layer up.
 */
let generation = 0;

const engineResident = () => Boolean(engine);

const isModelCached = () => isCached(MODEL_URL, EXPECTED_BYTES);

/**
 * Download the bytes if needed, then build the engine.
 *
 * `onProgress` receives `{ phase, text, progress }` where `phase` is `"download"` or
 * `"engine"`. The phase is explicit rather than inferred because the caller MUST be able
 * to distinguish them: a percentage that keeps reading 100% through a long GPU load is
 * exactly as much of a lie as one that reads 0% through a download, and the state machine
 * above has a state for each.
 */
const ensureEngine = async ({ onProgress = null, signal = null } = {}) => {
  if (engine) return engine;
  if (enginePromise) return enginePromise;

  const mine = generation;
  const superseded = () => mine !== generation;

  const attempt = (async () => {
    try {
      const source = await getModelSource(MODEL_URL, {
        expectedBytes: EXPECTED_BYTES,
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

      if (superseded()) {
        await created.delete().catch(() => {});
        throw abortError();
      }

      engine = created;
      enginePromise = null;
      return engine;
    } catch (err) {
      // Cleared so a failed load can be retried rather than replaying its own rejection,
      // but ONLY if this attempt is still current: a superseded one clearing these is
      // clearing its successor's, and a third engine starts while the second is loading.
      if (!superseded()) {
        enginePromise = null;
        engine = null;
      }
      throw explain(err);
    }
  })();

  enginePromise = attempt;
  return attempt;
};

/**
 * Free the engine: GPU memory and wasm state, but not the bytes on disk.
 *
 * Note that the panel's unload does NOT come here -- it frees the conversation and leaves
 * the engine hot, because the alternative is a tens-of-seconds GPU reload from a button
 * whose whole purpose is to be pressed mid-talk. This is for deleting the model.
 */
const unloadEngine = async () => {
  // Tells an in-flight create that it has been superseded: it deletes what it built rather
  // than installing it, and leaves the module's handles alone on the way out.
  generation += 1;
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
const deleteModel = async () => {
  await unloadEngine();
  return deleteCached(MODEL_URL);
};

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

/** Sampling temperature. Note the table above was measured at 0, the deterministic case. */
const TEMPERATURE = 0.7;

/**
 * A conversation, seeded with a preface.
 *
 * `createConversation` measures at ~2ms even with several turns of history, because the
 * preface is prefilled LAZILY -- `getTokenCount()` reads 0 until the first generation.
 * That is what makes rebuilding one per turn affordable, and why nothing here caches or
 * clones conversations.
 */
const newConversation = (system, pinned, history, { temperature }) =>
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
    },
  });

/**
 * The one place that reads a `Conversation`'s stream.
 *
 * `prepare` runs AFTER the lock is taken and returns the conversation to use, which is what
 * lets the chat rebuild its conversation without racing a live generation.
 *
 * IT MUST STAY AN ASYNC GENERATOR reading through an explicit reader.
 * `sendMessageStreaming` returns a ReadableStream, and Safari does not implement async
 * iteration on those -- no `Symbol.asyncIterator`, so `for await` throws. `session.js` uses
 * `for await`, which is only legal because a generator has one by construction. Simplifying
 * this to `return conversation.sendMessageStreaming(text)` keeps Chrome green and breaks
 * Safari.
 *
 * Yields DELTAS; `session.js` accumulates them, so a dropped chunk cannot desync the view.
 */
async function* streamFrom({ text, signal = null, prepare }) {
  const release = await acquire();
  let conversation = null;
  let reader = null;
  let drained = false;

  const cancel = () => {
    // The ONLY cancellation LiteRT offers -- there is no AbortSignal support anywhere in the
    // API, so an abort that does not reach this call does nothing at all: generation
    // continues, burning the GPU, until it finishes on its own.
    if (!conversation) return;
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
 * The durable chat session.
 *
 * WE OWN THE TRANSCRIPT; the `Conversation` is disposable and rebuilt every turn. The
 * obvious design -- let the `Conversation` keep its own history -- fails because what is
 * SENT and what is REMEMBERED must differ: a turn sends a position line that is false as
 * soon as the deck moves, and per-turn context that accumulates. Measured on five code
 * questions, letting it accumulate gave 2 of 5 usable answers against 5 of 5 on a fresh
 * conversation, with context climbing 0 -> 4338 tokens and answers degenerating into
 * "please provide the context".
 *
 * Rebuilding costs ~2ms plus prefill at ~1600 tok/s, and it makes `cancel()` poisoning
 * irrelevant -- one `cancel()` makes every later `sendMessageStreaming` on that
 * conversation reject with "Task cancelled" forever, and `clone()` inherits the poison and
 * loses the history, so the only safe move is to throw the object away.
 *
 * The transcript is BOUNDED because prefill is re-paid each turn; an unbounded one makes
 * every turn slower than the last.
 */

/** Exchanges kept for continuity. 6 messages = 3 question/answer pairs. */
const MAX_HISTORY_MESSAGES = 6;

const createChat = async ({ system }) => {
  await ensureEngine();

  /** The transcript WE keep. The `Conversation` is disposable; this is not. */
  let transcript = [];

  /**
   * Deck context already handed to the model, in the order it was sent.
   *
   * APPEND-ONLY AND NEVER TRIMMED, which is the one way it differs from `transcript`.
   * `deck-context.js` offers each slide at most once, so this grows with distinct slides
   * asked about rather than with turns -- bounded by the deck at 35 blocks.
   */
  let pinned = [];

  let conversation = await newConversation(system, [], [], {
    temperature: TEMPERATURE,
  });

  /** Last sampled token count, and the one-at-a-time guard for sampling it. */
  let tokens = 0;
  let sampling = false;

  const rebuild = async () => {
    const dead = conversation;
    conversation = await newConversation(system, pinned, transcript, {
      temperature: TEMPERATURE,
    });
    try {
      dead.cancel();
    } catch {
      /* nothing in flight */
    }
    dead.delete().catch(() => {});
  };

  const session = {
    /**
     * Stream one turn.
     *
     * TWO KINDS OF CONTEXT, GOING OPPOSITE WAYS, which is the whole signature.
     *
     * `pin` is a slide's text, sent the first time a question comes from that slide. It
     * goes into `pinned` rather than into `text`, so it survives history trimming and the
     * transcript keeps the question the user actually typed.
     *
     * `note` is where the deck is right now: prepended to the sent string and left out of
     * the transcript, so it is gone next turn. A position line is false as soon as the deck
     * moves, and pinning one puts it in the preface above the exchange it describes -- the
     * model then answers about the previous slide.
     */
    async *stream(
      text,
      { pin = "", note = "", signal = null, onPrompt = null } = {},
    ) {
      let answer = "";
      // Whether this turn actually reached the model. Everything in `prepare` can throw --
      // a rebuild, a lock teardown, an engine error -- and a turn that died there was never
      // sent, so recording it below would put a question and an empty answer into the
      // model's own history and prefix the next preface with them.
      let sent = false;
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
            //
            // Rolled back if the rebuild fails: a pin recorded against a conversation
            // that was never built is the same dangling reference `deck-context.js`
            // guards against, one layer down.
            const pinnedBefore = pinned.length;
            if (pin) pinned.push({ role: "user", content: pin });
            try {
              await rebuild();
            } catch (err) {
              pinned.length = pinnedBefore;
              throw err;
            }
            // Reported after the rebuild that consumed it, so this is the preface the
            // conversation was actually built from -- trimmed to `MAX_HISTORY_MESSAGES`,
            // unlike the panel's transcript. Copied, not passed by reference: `transcript`
            // is reassigned by the slice below on the next turn.
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
            sent = true;
            return conversation;
          },
        })) {
          answer += delta;
          yield delta;
        }
      } finally {
        // Recorded even on abort -- the presenter saw a partial answer and the transcript
        // should match the screen -- but NOT when the turn never reached the model.
        //
        // BARE `text`, not the sent string: `note` is dropped here on purpose. A position
        // line is true for one turn, and a transcript accumulating five contradictory ones
        // is the accumulation failure in miniature.
        if (sent) {
          transcript.push(
            { role: "user", content: text },
            { role: "assistant", content: answer },
          );
          if (transcript.length > MAX_HISTORY_MESSAGES) {
            transcript = transcript.slice(-MAX_HISTORY_MESSAGES);
          }
        }
      }
    },

    /**
     * Live context occupancy: preface plus every turn so far.
     *
     * SYNCHRONOUS, because the UI reads it during render. LiteRT's `getTokenCount()` is
     * async, so the number is cached here and refreshed out of band by `sampleContext()`.
     * Chrome needs neither -- it reads `inputUsage` straight off its session.
     *
     * Reads 0 until the first generation, because the preface prefills lazily. Nothing has
     * been spent yet, so 0 is the honest number.
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
     * Dropping the transcript is what clears the context, since the next turn rebuilds from
     * it. Mutates in place so every reference to the session stays valid.
     *
     * `pinned` MUST BE CLEARED WITH IT. Callers of `restart()` bump `epoch`, and
     * `deck-context.js` clears its seen-set from `epoch` -- so a surviving `pinned` would
     * meet a policy that has forgotten those slides and offers them again, putting two
     * copies of one slide in a single preface.
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
 * contract and for where the two providers disagree.
 */
export const provider = {
  id: "litert",
  label: "Gemma",

  capabilities: {
    // We fetched the bytes, so progress is real and cancel is a real abort.
    ownsBytes: true,
    canDelete: true,
    downloadBytes: EXPECTED_BYTES,
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
      title: `Model not downloaded — click to fetch it (${gb(EXPECTED_BYTES)} GB)`,
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
    const storage = await storageRoom(EXPECTED_BYTES).catch(() => null);

    let wasm;
    try {
      wasm = wasmUrl();
    } catch (err) {
      wasm = `unresolved: ${err.message}`;
    }

    return [
      ["Model", `${MODEL.label} · ${MODEL.quantization}`],
      ["File", `${MODEL.file} (${gb(EXPECTED_BYTES)} GB)`],
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
