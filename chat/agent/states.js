/**
 * The eight states a model can be in, in their own module.
 *
 * Split out of `model-state.js` for a boring but hard reason: the providers need these to
 * report status, and `model-state.js` imports the providers. As one module that is a
 * circular import, and native ESM resolves it by evaluating the provider FIRST -- so
 * `STATES` would still be in its temporal dead zone when the provider's module body runs.
 * No build step here to paper over it. A leaf module both sides import is the fix.
 *
 * The set fits both providers, but three of them strain, and the seams are worth knowing:
 *
 *   DOWNLOADING   Two different states wearing one name. LiteRT's is a fact we own, with a
 *                 real cancel button. Chrome's is a report from the browser whose only
 *                 available action is to look again -- and which has been measured stuck for
 *                 over ninety minutes. Hence per-provider `stateMeta` and the
 *                 `authoritativeStatus` capability that `session.js` reads before refusing a
 *                 question.
 *
 *   CREATING      The ceiling on this phase means opposite things per provider. See the note
 *                 on `createCeilingMs` in `providers/index.js`.
 *
 *   UNSUPPORTED   Unreachable for Chrome under the "only offer it when the global exists"
 *                 rule -- the provider list handles that case, not the state machine. Kept
 *                 anyway, because the global can exist and `availability()` still throw.
 */
export const STATES = {
  UNSUPPORTED: "unsupported",
  UNAVAILABLE: "unavailable",
  DOWNLOADABLE: "downloadable",
  DOWNLOADING: "downloading",
  ON_DISK: "on-disk",
  CREATING: "creating",
  READY: "ready",
  ERROR: "error",
};
