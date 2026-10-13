/**
 * Calling the deck's own tools back through the browser's WebMCP host.
 *
 * WHY GO ROUND. The in-page model could call the registry directly, and in Firefox and
 * Safari it still does. Where the browser has `executeTool`, going through it means a
 * call from the chat panel takes the same route as a call from an extension or a relay:
 * the browser looks the tool up and runs the `execute` the page registered. That is the
 * claim the WebMCP slides make, done rather than drawn.
 *
 * WHAT CHROME HANDS BACK, checked in Chrome against this deck in October 2026:
 *
 *   - `getTools()` lists every tool the browser knows, each with `name`, `origin` and
 *     `window`. `window` is the frame that registered it, which is the exact test for
 *     "ours" -- `origin` alone would also match another tab or frame on the same host.
 *   - `executeTool()` resolves to a JSON string of whatever `execute` returned, and to
 *     `null` if the call navigated the page.
 *   - It does not check arguments against `inputSchema`. A bad slide number reaches the
 *     tool, and the tool's own refusal comes back.
 *   - Chrome 154 and earlier take the arguments as a JSON STRING, and reject an object
 *     with "Failed to parse input arguments" before the tool runs. 155 takes the object.
 *     There is no flag to tell them apart, so the first refusal is the test: see
 *     `execute` below.
 *
 * No DOM imports, so `test/host.test.js` can run it in node against a fake host.
 */

/** Which route a call took, as the context viewer and `deckMcp` report it. */
export const VIA = { webmcp: "webmcp", direct: "direct" };

/** Text-only MCP result. */
const textResult = (text, isError = false) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text }],
});

/**
 * What `executeTool` resolved with, as the MCP result every caller already reads.
 *
 * A STRING IS PARSED, because that is what Chrome returns. One that is not JSON is passed
 * on as text rather than thrown: it is still the tool's answer, and the receipt can show it.
 * `null` is the navigation case. No deck tool navigates, so it says so rather than "Done."
 */
export const fromHost = (value) => {
  if (value === null || value === undefined) {
    return textResult("The call navigated the page before it returned.");
  }
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return textResult(value);
  }
};

/** How Chrome 154 and earlier refuse arguments passed as an object. */
const STRING_ARGS_REFUSAL = /parse input arguments/i;

/**
 * Build the dispatcher.
 *
 * `getModelContext` and `win` are passed in rather than read from globals, so a test can
 * hand it a fake host and a fake window. `enabled` is read per call, so `?direct` is a
 * flag rather than an install-time decision.
 */
export const createDispatch = ({
  getModelContext,
  win,
  enabled = () => true,
}) => {
  // The host's tool list, kept until it changes. `getTools()` is async and every turn
  // would otherwise pay for it; `toolchange` is the host saying the list moved.
  //
  // THE PROMISE IS KEPT, NOT THE LIST. Two calls at once share one `getTools()`, and a
  // `toolchange` while it is pending drops it, rather than the stale list landing in
  // the cache after the event that should have cleared it.
  let listing = null;
  let listening = null;

  const usable = () => {
    const mc = getModelContext();
    return enabled() &&
      typeof mc?.executeTool === "function" &&
      typeof mc?.getTools === "function"
      ? mc
      : null;
  };

  /**
   * This window's entry for `name` in the host's list, or null.
   *
   * Null also when `getTools()` rejects: the call can still be made directly, and a
   * turn that fails over a tool LIST would be the deck failing for the host's reasons.
   * A miss or a rejection drops the cache, so the next call asks again rather than
   * staying direct until a `toolchange` that may never come.
   */
  const hostTool = async (mc, name) => {
    if (listening !== mc) {
      mc.addEventListener?.("toolchange", () => (listing = null));
      listening = mc;
    }
    const pending = (listing ??= mc.getTools());
    try {
      const found = (await pending).find(
        (tool) => tool.name === name && tool.window === win,
      );
      if (!found && listing === pending) listing = null;
      return found ?? null;
    } catch (error) {
      if (listing === pending) listing = null;
      console.warn(`[mcp] host getTools() failed: ${error?.message ?? error}`);
      return null;
    }
  };

  // Tool names already warned about, so a missing tool says so once, not every turn.
  const warned = new Set();

  // The host found to want its arguments as a JSON string (Chrome 154 and earlier).
  let stringHost = null;

  /**
   * `executeTool`, with the arguments in whichever form this host takes.
   *
   * Objects first, as 155+ wants. A parse refusal is safe to retry: the host rejected the
   * call before running the tool, so nothing happened twice. The answer is kept per host,
   * so later calls go straight to the string form.
   */
  const execute = async (mc, found, args) => {
    if (stringHost !== mc) {
      try {
        return await mc.executeTool(found, args);
      } catch (error) {
        if (!STRING_ARGS_REFUSAL.test(error?.message ?? "")) throw error;
        stringHost = mc;
        console.warn("[mcp] host wants JSON-string arguments (Chrome < 155)");
      }
    }
    return mc.executeTool(found, JSON.stringify(args ?? {}));
  };

  /**
   * Run one registry tool, through the host when there is one.
   *
   * Resolves to `{ result, via }`. Never rejects for a tool failure: `guard()` already
   * turns a throw into an `isError` result, and a host that rejects is turned into one
   * here, so the retry loop reads a refusal either way.
   */
  const dispatch = async (tool, args) => {
    const mc = usable();
    if (!mc) return { result: await tool.call(args), via: VIA.direct };

    const found = await hostTool(mc, tool.name);
    if (!found) {
      // Registered but not listed: the host and the registry disagree. The call still
      // happens, directly, and the console says so once per tool.
      if (!warned.has(tool.name)) {
        warned.add(tool.name);
        console.warn(
          `[mcp] ${tool.name} not in the host's tool list; calling directly`,
        );
      }
      return { result: await tool.call(args), via: VIA.direct };
    }

    try {
      return {
        result: fromHost(await execute(mc, found, args)),
        via: VIA.webmcp,
      };
    } catch (error) {
      return {
        result: textResult(
          `${tool.name} failed in the host: ${error?.message ?? error}`,
          true,
        ),
        via: VIA.webmcp,
      };
    }
  };

  /** The route the next call would take, for `deckMcp.via` and the inspector. */
  dispatch.via = () => (usable() ? VIA.webmcp : VIA.direct);

  /** Forget the cached list, for teardown and for a test. */
  dispatch.reset = () => {
    listing = null;
    stringHost = null;
    warned.clear();
  };

  return dispatch;
};
