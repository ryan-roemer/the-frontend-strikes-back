/**
 * The model bytes: download, cache, verify, delete.
 *
 * LiteRT-LM caches nothing itself -- `Engine.create({ model })` takes a URL, a Blob or a
 * ReadableStream and reads it once -- so the page owns the download. That is what gives
 * the status row real byte-level progress, a working "on disk?" answer, and the ability to
 * delete the model again.
 *
 * Two rules govern everything here:
 *
 * 1. NOTHING BUFFERS THE WHOLE MODEL. It is 2 GB. Every path is a stream or a Blob handed
 *    to the engine by reference; the JS heap never holds more than one chunk.
 * 2. A CACHED ENTRY IS NOT TRUSTED UNTIL ITS SIZE IS CHECKED. An aborted, quota-killed or
 *    partially-evicted `cache.put` leaves a SHORT entry, `cache.match` happily returns it,
 *    and the engine fails on truncated bytes with a message about wasm sections -- which
 *    reads as permanent, inexplicable breakage. Size is checked on write AND on read, and
 *    a bad entry is deleted rather than reported.
 *
 * This module knows nothing about LiteRT: it takes a URL and a byte count, which makes the
 * download testable without a 2 GB model or a GPU.
 */

const CACHE_NAME = "deck-litert-models-v1";

/**
 * Absent in some WebKit contexts. There we stream from the network on every load, which
 * works and is merely slow -- so it is a degradation, not a failure.
 */
export const cacheAvailable = typeof caches !== "undefined";

/** Decimal MB/GB, because that is what the OS, the browser and HuggingFace all show. */
const mb = (bytes) => Math.round(bytes / 1e6);
export const gb = (bytes) => (bytes / 1e9).toFixed(1);

/**
 * Quota errors are not reliably identifiable by name: Chrome and Safari throw
 * `QuotaExceededError`, Firefox a bare `TypeError` or `AbortError` from `cache.put` under
 * storage pressure. A false negative is a hard failure after a completed 2 GB download; a
 * false positive merely runs uncached. So the message is sniffed too.
 */
const isQuotaError = (err) =>
  err?.name === "QuotaExceededError" ||
  /quota|storage|space|exceed/i.test(String(err?.message ?? err));

/**
 * Is there room, and should we even try to cache?
 *
 * Returns a verdict rather than throwing, because "no room" is not an error: streaming
 * uncached is a perfectly good fallback and the presenter should be told, not stopped.
 *
 * Neither Safari's nor Firefox's `estimate()` is trustworthy -- Safari reports an
 * aspirational quota and then throws on `put` anyway, Firefox reports a group limit. So
 * this is the first of two defences, not the only one; see `getModelSource`.
 */
export const storageRoom = async (expectedBytes) => {
  if (!navigator.storage?.estimate) return { ok: true, unknown: true };
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (!quota) return { ok: true, unknown: true };
    const free = quota - (usage ?? 0);
    if (free >= expectedBytes) return { ok: true, free, quota };
    return {
      ok: false,
      free,
      quota,
      reason:
        `needs ${mb(expectedBytes)} MB but only ${mb(free)} MB of the ` +
        `${mb(quota)} MB origin quota is free`,
    };
  } catch {
    return { ok: true, unknown: true };
  }
};

/**
 * Ask to be exempt from eviction. Call this ONLY from the download click.
 *
 * Chrome grants it silently for an engaged origin. Firefox shows a permission doorhanger --
 * browser chrome appearing mid-talk is worse than the eviction it prevents, so this must
 * never run from a mount-time probe. Safari does not implement it at all. A denial costs a
 * re-download later, which the size check will catch cleanly, so the result is ignored.
 */
const requestPersistence = async () => {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
};

/** Open the cache, or null if the API is missing or refuses. */
const openCache = async () => {
  if (!cacheAvailable) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
};

/**
 * What a cached entry says its own full size is.
 *
 * THE ENTRY IS THE AUTHORITY ON ITSELF, not a constant compiled into the page. `cache.put`
 * stores the upstream response's headers with the body, so the `content-length` served
 * with those exact bytes is still readable -- which answers the question the integrity
 * check is actually asking, and keeps answering it if upstream republishes at a different
 * size. `expected` is only the fallback for an entry carrying no `content-length`.
 */
const declaredSize = (response, expected) => {
  const header = Number(response.headers.get("content-length"));
  return Number.isFinite(header) && header > 0 ? header : expected;
};

/**
 * Is the model on disk, complete and usable?
 *
 * The size check is what makes this answer mean something. A truncated entry reports
 * `false` and is deleted on the spot, so the status row shows "download" -- a deliberate
 * click -- rather than "on disk" followed by a load that can never succeed.
 */
export const isCached = async (url, expectedBytes) => {
  const cache = await openCache();
  if (!cache) return false;
  try {
    const hit = await cache.match(url);
    if (!hit) return false;
    const want = declaredSize(hit, expectedBytes);
    const size = (await hit.blob()).size;
    if (size === want) return true;
    console.warn(
      `[chat] discarding an incomplete cached model (${mb(size)} of ${mb(want)} MB)`,
    );
    await cache.delete(url);
    return false;
  } catch {
    return false;
  }
};

/** Drop the model from disk. The affordance the Prompt API could not offer. */
export const deleteCached = async (url) => {
  const cache = await openCache();
  if (!cache) return false;
  try {
    return await cache.delete(url);
  } catch (err) {
    console.warn("[chat] could not delete the cached model:", err.message);
    return false;
  }
};

/**
 * Wrap a body stream so every chunk reports progress.
 *
 * Throttled on TIME, not on percent. At 2 GB a one-percent step is one update per 20 MB,
 * which on venue wifi is a frozen number for minutes. And the byte counts are always in
 * the text, because a percentage alone cannot distinguish a slow download from a stalled
 * one -- which is the single question a presenter watching this actually has.
 */
const withProgress = (body, totalBytes, onProgress) => {
  if (!onProgress) return body;

  let loaded = 0;
  let lastReportAt = 0;

  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        // Enqueue first, unconditionally. Every early return below must be incapable of
        // dropping a chunk, or the cached model is silently short.
        controller.enqueue(chunk);
        loaded += chunk.byteLength;

        const now = Date.now();
        const isLast = totalBytes && loaded >= totalBytes;
        if (now - lastReportAt < 250 && !isLast) return;
        lastReportAt = now;

        onProgress({
          loaded,
          text: totalBytes
            ? `${mb(loaded)} / ${mb(totalBytes)} MB`
            : `${mb(loaded)} MB`,
          progress: totalBytes ? loaded / totalBytes : 0,
        });
      },
    }),
  );
};

/**
 * A source for `Engine.create({ model })`, downloading and caching as needed.
 *
 * Four paths, in order of preference:
 *
 *   cache hit          -> a Blob out of the Cache API. The engine streams it; no heap copy.
 *   cache miss         -> stream the download into the cache, then read it back as a Blob.
 *                         Two disk passes, but the bytes never land in the JS heap.
 *   no room / no API   -> the progress-wrapped network stream, straight to the engine.
 *                         Works every time, costs a re-download on the next run.
 *   cache write failed -> same as above, after a re-fetch. See the warning below.
 *
 * @param {string} url
 * @param {object} opts
 * @param {number} opts.expectedBytes  Exact size. Load-bearing: this is the integrity check.
 * @param {Function} [opts.onProgress] Called with `{ loaded, text, progress }`.
 * @param {AbortSignal} [opts.signal]  Cancels the fetch; the caller owns the stall timer.
 * @returns {Promise<Blob|ReadableStream>}
 */
export const getModelSource = async (
  url,
  { expectedBytes, onProgress = null, signal = null } = {},
) => {
  let cache = await openCache();

  // ASKED HERE, AND ONLY HERE. Reaching this function means a deliberate load -- the
  // mount-time probe goes through `isCached`, which never comes this way -- so this is the
  // "download click" `requestPersistence` needs, and Firefox's permission doorhanger
  // cannot appear over slide 1.
  //
  // BEFORE THE CACHE-HIT BRANCH: asking only on a miss never protects a model that was
  // already on disk, which is the state most machines are in by the time anyone presents.
  //
  // DELIBERATELY NOT AWAITED. Firefox does not resolve `persist()` until the user answers
  // the doorhanger, and a load that stalls until somebody notices a permission prompt is
  // worse than an unprotected entry. It never rejects. A denial costs a re-download, which
  // the size check catches cleanly.
  if (cache) requestPersistence();

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const want = declaredSize(hit, expectedBytes);
      const blob = await hit.blob();
      if (blob.size === want) return blob;
      // Checked again here rather than trusting `isCached`: the entry can be evicted or
      // rewritten between the two calls, and handing truncated bytes to the engine costs
      // a minute of GPU load before failing with a message about wasm sections.
      await cache.delete(url);
      throw new Error(
        `The cached model was incomplete (${mb(blob.size)} of ${mb(want)} MB) and has ` +
          "been discarded. Download it again.",
      );
    }

    // First of two quota defences. Deciding up front is much better than discovering it
    // afterwards, because the failure path below has to re-download.
    const room = await storageRoom(expectedBytes);
    if (!room.ok) {
      console.warn(`[chat] not caching the model: ${room.reason}`);
      cache = null;
    }
  }

  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(
      `Could not download the model (${response.status} ${response.statusText}).`,
    );
  }

  // THE SERVER'S NUMBER WINS, and `expectedBytes` is only the fallback for a response that
  // carried no `content-length`. Everything downstream -- the progress total, the
  // post-write verification, and the `content-length` that goes into the cache entry for
  // future runs to check against -- keys off this rather than off the constant.
  const header = response.headers.get("content-length");
  const totalBytes = header ? Number(header) : expectedBytes;
  const stream = withProgress(response.body, totalBytes, onProgress);

  // A DISAGREEMENT IS NEWS, NOT A FAILURE. `expectedBytes` doubles as a version pin -- the
  // model is pinned by repo and filename only, so a republished file shows up here first.
  // Worth saying out loud before a talk, but refusing to run would be strictly worse:
  // checking truncation against the constant makes an upstream change fail, delete itself,
  // and fail again on retry, reporting "incomplete" about a complete file.
  if (header && totalBytes !== expectedBytes) {
    console.warn(
      `[chat] the model upstream is ${mb(totalBytes)} MB, not the pinned ${mb(expectedBytes)} MB. ` +
        "Downloading it anyway; the weights may differ from the ones this deck was tested with.",
    );
  }

  // Nothing to cache into: hand the engine the live network stream.
  if (!cache) return stream;

  try {
    // `put` consumes the stream, so the bytes go network -> disk without ever being fully
    // materialized in memory.
    await cache.put(url, new Response(stream, { headers: response.headers }));
  } catch (err) {
    // Never leave a partial entry behind -- `isCached` would have to clean it up later,
    // and until it did the status row would claim the model was on disk.
    await cache.delete(url).catch(() => {});
    if (!isQuotaError(err)) throw err;

    // Second quota defence, for the browsers whose `estimate()` lied. This costs a second
    // 2 GB download, which is why the pre-check above is the primary defence and this is
    // the last resort -- but it does mean a small origin quota degrades to "works, slowly"
    // instead of "cannot run the model at all".
    console.warn(
      "[chat] the model would not fit in the cache; streaming it uncached instead:",
      err.message,
    );
    const retry = await fetch(url, signal ? { signal } : undefined);
    if (!retry.ok) {
      throw new Error(
        `Could not download the model (${retry.status} ${retry.statusText}).`,
      );
    }
    return withProgress(retry.body, totalBytes, onProgress);
  }

  const stored = await cache.match(url);
  const blob = stored ? await stored.blob() : null;
  // Against `totalBytes`, the size THIS response promised, not the pinned constant. The
  // question here is "did all the bytes arrive", and only the server's own count can
  // answer it -- checking the constant instead conflated a truncated download with an
  // upstream file that had legitimately changed, and made the second unrecoverable.
  if (!blob || blob.size !== totalBytes) {
    // A short entry here means the download itself was truncated -- a dropped connection
    // that still resolved, or an eviction racing the write. Delete it, so the next attempt
    // starts from a clean miss rather than a poisoned hit.
    await cache.delete(url).catch(() => {});
    throw new Error(
      `The download finished but was incomplete (${blob ? mb(blob.size) : 0} of ` +
        `${mb(totalBytes)} MB). Try again.`,
    );
  }
  return blob;
};
