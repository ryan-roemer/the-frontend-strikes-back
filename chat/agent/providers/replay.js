/**
 * A provider that reads its answers off a script instead of a model.
 *
 * WHY THIS IS A PROVIDER AND NOT A TEST DOUBLE BOLTED ON THE SIDE. `respond.js` imports
 * `streamAnswer` statically, and everything worth testing above the model -- fence
 * suppression, the correction pass, the candidates retry, receipts -- lives above that
 * import. The provider interface is the one seam already designed to be swapped, so a
 * third entry in `ALL` gets the whole stack under test with no mocking and no change to
 * any module that does real work.
 *
 * WHAT THIS BUYS THAT `deckMcp.call()` DOES NOT. Calling a tool directly proves the tool
 * works. Replaying a transcript proves the PATH works: that this reply dispatched that
 * call, that a prose turn dispatched nothing, and that one turn consumed one model reply
 * rather than silently taking two down the retry path.
 *
 * DETERMINISTIC BY CONSTRUCTION. `stream()` ignores its prompt entirely. That looks lazy
 * and is the point -- a script keyed on the prompt would quietly stop matching the moment
 * the deck's wording changed, which is a fixture that rots into a skip. Order is the
 * contract, and a misalignment is a hard failure rather than a fallback.
 *
 * OFF UNLESS `?replay`, so it is absent from the switcher, absent from `pick()`, and
 * cannot be reached by a stray localStorage key on a machine at a podium.
 */
import { STATES } from "../states.js";
import { flag } from "../../url.js";

/**
 * Replies waiting to be handed over, oldest first.
 *
 * MODULE STATE RATHER THAN A HANDLE FIELD, because `acquire()` may be called more than
 * once -- a provider switch, a `restart()` -- and a queue that resets with the session
 * would lose a transcript mid-replay for reasons that have nothing to do with the fixture.
 */
let queue = [];

/** Every reply handed over, for the alignment check a runner makes when a turn ends. */
let taken = [];

/** How much of a reply arrives per delta. */
const CHUNK = 24;

/**
 * SEVERAL DELTAS, NOT ONE, and the size is load-bearing. `respond.js` decides whether a
 * reply is a call or prose from the first few characters and never revisits it, so a reply
 * delivered whole would skip the streaming verdict entirely and leave `sniff()`'s partial
 * states -- the "```too" case -- untested by every fixture. 24 characters splits a fence
 * from its JSON, which is the boundary that matters.
 */
const deltas = function* (reply) {
  for (let i = 0; i < reply.length; i += CHUNK) {
    yield reply.slice(i, i + CHUNK);
  }
};

/**
 * The next scripted reply.
 *
 * THROWS ON AN EMPTY QUEUE rather than returning "". An exhausted script means the code
 * under test asked for a reply the fixture did not predict -- a turn that took two model
 * calls where the transcript recorded one -- and that IS the finding. Answering with
 * silence would let it pass as an odd but green result.
 */
const next = () => {
  if (!queue.length) {
    throw new Error(
      `replay: the script is exhausted — something asked for a model reply the fixture does not have. ${taken.length} handed over so far.`,
    );
  }
  const reply = queue.shift();
  taken.push(reply);
  return reply;
};

const handle = () => ({
  async *stream(text, { onPrompt } = {}) {
    // Reported like a real provider would, so a runner can still assert on what the
    // system prompt and pinned region held even though nothing reads them here.
    onPrompt?.({
      provider: "replay",
      system: null,
      pinned: [],
      history: [],
      message: text,
      historyLimit: null,
    });
    yield* deltas(next());
  },
  context: () => null,
  sampleContext: async () => {},
  restart: async () => {},
  destroy: () => {},
  benchmark: async () => null,
});

/**
 * The runner's surface. Exported rather than put on `window` here: whatever mounts the
 * in-page runner owns that decision, the same way `mcp/index.js` owns `window.deckMcp`.
 */
export const script = {
  /** Load a fixture's replies. Replaces whatever was queued -- a fresh transcript is a
   *  fresh run, and merging two scripts is never what anybody meant. */
  load: (replies) => {
    queue = [...replies];
    taken = [];
  },
  /** How many replies the code under test has consumed. A turn asserts on the delta. */
  taken: () => taken.length,
  /** How many are left. Non-zero at the end of a transcript is a turn that never ran. */
  pending: () => queue.length,
};

export const provider = {
  id: "replay",
  label: "Replay",

  capabilities: {
    ownsBytes: false,
    canDelete: false,
    downloadBytes: null,
    // Nothing here is a sample: the queue either has a reply or it does not.
    authoritativeStatus: true,
    cheapRestart: true,
  },

  timings: { stallMs: 1000, createCeilingMs: 1000 },

  // Nothing to override: this provider is never in a state a person has to be told about.
  stateMeta: {},

  offered: () => flag("replay"),

  probe: async () => ({ ok: true, supported: true, reason: null }),

  status: async () => STATES.READY,

  acquire: async () => handle(),

  release: () => {},
  evict: async () => {},
  resident: () => true,

  info: async () => [
    ["Model", "none — replaying a recorded transcript"],
    ["Replies handed over", String(taken.length)],
    ["Replies pending", String(queue.length)],
  ],

  unavailableCopy: () => ({
    lead: "The replay provider is a test harness, and it is never unavailable.",
    bullets: ["If you are seeing this, remove ?replay from the URL."],
  }),
};
