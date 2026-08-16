/* global AbortController:false */
import { useCallback, useRef, useState } from "react";

/**
 * The transcript, and the one in-flight turn.
 *
 * Deliberately ignorant of the model. It takes a `respond` function and drives
 * it, so the panel can be built and exercised against an echo responder before
 * any session exists, and so the model layer can be replaced without touching
 * any of this.
 *
 * `respond({ text, onChunk, signal })` streams by calling `onChunk` with the
 * ACCUMULATED text (not deltas -- that is what both reference implementations
 * hand their UI, and it means a dropped chunk cannot desync the display), and
 * resolves with the final string.
 *
 * Entries are `{ role, text, stopped?, prompt? }`. The streaming turn is kept OUT
 * of the entry list, in `streaming`, so a partial answer can be discarded on abort
 * without having to unwind an array.
 *
 * `prompt` is what the responder reported through `onPrompt` -- the context that
 * produced THIS answer, frozen at send time. It rides on the entry rather than
 * being looked up later because the model's history is trimmed and rewritten as
 * the conversation goes on: by the time anyone clicks to see it, the answer to
 * "what was sent" no longer exists anywhere else. Absent on entries whose turn
 * never reached the model.
 *
 * STOPPING DOES NOT WAIT FOR THE RESPONDER.
 *
 * The first version aborted the controller and let the `finally` clear `busy` when
 * the promise settled. That is wrong whenever the promise never settles -- and
 * under the Chrome Prompt API, which hung inside `create()`, it never did: the stop
 * button aborted a signal nobody was listening to and the panel stayed busy
 * forever. So `stop()` now does the bookkeeping itself, immediately, and a run
 * token makes any late-arriving result from the abandoned turn get discarded
 * instead of appearing minutes later under a question the user has moved on from.
 *
 * That design survived the move to LiteRT because it turned out to be load-bearing
 * for a different reason. LiteRT DOES cancel promptly -- but `conversation.cancel()`
 * permanently poisons the conversation it is called on, so the provider has to
 * rebuild one behind our back before the next turn (see `providers/litert.js`).
 * Clearing `busy` here without waiting is what lets that happen out of sight, and
 * it is why the composer is usable ~11ms after the click rather than after a
 * teardown and a rebuild. Measured.
 */
export const useConversation = (respond) => {
  const [entries, setEntries] = useState([]);
  const [streaming, setStreaming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  // Mirrors `streaming` for the stop handler, which needs the latest partial text
  // without being re-created on every chunk.
  const streamingRef = useRef(null);
  // Identifies the current turn. Anything from an older turn is ignored.
  const runRef = useRef(0);
  // The context the responder reported for the turn in flight, held here until
  // there is an entry to attach it to.
  const promptRef = useRef(null);

  const send = useCallback(
    async (text) => {
      const message = text.trim();
      if (!message || busy) return;

      const run = ++runRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      setEntries((prev) => [...prev, { role: "user", text: message }]);
      setError(null);
      setStreaming("");
      streamingRef.current = "";
      promptRef.current = null;
      setBusy(true);

      const current = () => runRef.current === run;

      try {
        const result = await respond({
          text: message,
          signal: controller.signal,
          onChunk: (accumulated) => {
            if (!current()) return;
            streamingRef.current = accumulated;
            setStreaming(accumulated);
          },
          onPrompt: (context) => {
            if (!current()) return;
            promptRef.current = context;
          },
        });

        if (!current()) return;

        setEntries((prev) => [
          ...prev,
          {
            role: "assistant",
            text: result ?? streamingRef.current ?? "",
            prompt: promptRef.current,
          },
        ]);
      } catch (err) {
        // `stop()` has already recorded the partial and cleared the busy state, so
        // an abort needs nothing here beyond not being reported as a failure.
        if (!current() || err.name === "AbortError") return;
        setError(err.message || String(err));
      } finally {
        if (current()) {
          abortRef.current = null;
          streamingRef.current = null;
          setStreaming(null);
          setBusy(false);
        }
      }
    },
    [busy, respond],
  );

  /**
   * Stop now, whether or not the responder cooperates.
   *
   * Bumping the run token first is what makes this safe: the abandoned turn can
   * still resolve later, and every one of its callbacks and its `finally` will see
   * a stale token and do nothing.
   */
  const stop = useCallback(() => {
    if (!busy) return;
    runRef.current += 1;

    const partial = streamingRef.current;
    // Read before the reset below. A stopped answer was still produced from a real
    // context, and that is exactly the turn someone wants to inspect.
    const prompt = promptRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = null;
    promptRef.current = null;

    if (partial) {
      setEntries((prev) => [
        ...prev,
        { role: "assistant", text: partial, stopped: true, prompt },
      ]);
    }
    setStreaming(null);
    setBusy(false);
  }, [busy]);

  /** Clears the transcript. Does NOT touch the model session -- that is owned by
   *  the model-state machine, which drives this the other way via `epoch`. */
  const clear = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = null;
    promptRef.current = null;
    setEntries([]);
    setStreaming(null);
    setError(null);
    setBusy(false);
  }, []);

  return { entries, streaming, busy, error, send, stop, clear };
};
