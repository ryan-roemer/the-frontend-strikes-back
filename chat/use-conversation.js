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
 * hand their UI, and it means a dropped chunk cannot desync the display). It
 * resolves with either a string or `{ text, receipts }`, where receipts describe
 * deck edits the turn applied.
 *
 * Entries are `{ role, text, receipts? }`. The streaming turn is kept OUT of the
 * entry list, in `streaming`, so a partial answer can be discarded on abort
 * without having to unwind an array.
 *
 * STOPPING DOES NOT WAIT FOR THE RESPONDER.
 *
 * The first version aborted the controller and let the `finally` clear `busy` when
 * the promise settled. That is wrong whenever the promise never settles -- and with
 * the Prompt API hanging inside `LanguageModel.create()`, it never did: the stop
 * button aborted a signal nobody was listening to and the panel stayed busy
 * forever. So `stop()` now does the bookkeeping itself, immediately, and a run
 * token makes any late-arriving result from the abandoned turn get discarded
 * instead of appearing minutes later under a question the user has moved on from.
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
        });

        if (!current()) return;

        const answer = typeof result === "string" ? { text: result } : result;
        setEntries((prev) => [
          ...prev,
          {
            role: "assistant",
            text: answer?.text ?? streamingRef.current ?? "",
            receipts: answer?.receipts,
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
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = null;

    if (partial) {
      setEntries((prev) => [
        ...prev,
        { role: "assistant", text: partial, stopped: true },
      ]);
    }
    setStreaming(null);
    setBusy(false);
  }, [busy]);

  /** Clears the transcript. Does NOT touch the model session or deck edits --
   *  those are owned by the model-state machine and the patch log. */
  const clear = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = null;
    setEntries([]);
    setStreaming(null);
    setError(null);
    setBusy(false);
  }, []);

  return { entries, streaming, busy, error, send, stop, clear };
};
