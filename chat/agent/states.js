/**
 * The eight states a model can be in.
 *
 * A LEAF MODULE, not part of `model-state.js`, because the providers need these and
 * `model-state.js` imports the providers. As one module that is a circular import, and
 * native ESM evaluates the provider first, leaving `STATES` in its temporal dead zone.
 * There is no build step here to paper over it.
 *
 * DOWNLOADING is two states wearing one name: LiteRT's is a fact the page owns, with a real
 * cancel; Chrome's is a browser report whose only action is to look again, measured stuck
 * for over ninety minutes. Hence per-provider `stateMeta` and `authoritativeStatus`.
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
