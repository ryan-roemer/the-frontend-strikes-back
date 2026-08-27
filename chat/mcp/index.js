/**
 * The deck, as a WebMCP server.
 *
 * Everything `chat/harvest/` built -- 162 addressable nodes, roles, provenance,
 * live elements, `locate()` -- was reachable only from a console. This registers
 * it as real tools, so an agent in a browser side panel can discover the deck's
 * content, move around it, and change it.
 *
 * IT IS THE TALK. Slide 9 says "the page registers tools, the agent discovers
 * and calls them." After this, that is not a diagram of somebody else's app.
 *
 * DETERMINISTIC ON OUR SIDE. Nothing here runs a model; the intelligence is
 * whatever connects. That is the point of building it before wiring the
 * on-device model: the addressing, the resolution and the mutation path all get
 * exercised by something that already works, so when the 2B model arrives the
 * only new variable is the model.
 */
import { installEditTools, READ_TOOLS, NAV_TOOLS } from "./tools.js";
import { flag } from "../url.js";

/**
 * `document` first, `navigator` second.
 *
 * `document.modelContext` is where the standard is going; `navigator` is the
 * earlier shape. Both are checked because a page cannot know which host it
 * landed in -- an extension that injects the bridge, a flagged Chrome, or
 * nothing at all.
 */
export const getModelContext = () =>
  document.modelContext ?? navigator.modelContext;

/**
 * Whether the deck may be CHANGED. On by default; `?safe` turns it off.
 *
 * INVERTED FROM `?mcp`, which used to have to be typed to unlock writing. That
 * default was wrong for what this is now: the tools exist to be demonstrated,
 * and a demo that needs a remembered query parameter before it does anything is
 * a demo that fails in front of an audience. Everything registers on a plain
 * load.
 *
 * `?safe` REMAINS, because the risk the old default was guarding against is
 * real: a stray tool call can rewrite a slide while it is on screen. It is a
 * kill switch rather than a lock -- short enough to type at a podium, and the
 * one thing to reach for if a host is connected and behaving unpredictably.
 *
 * Paged output never gets this far: `mountChat()` returns before `installTools()`
 * when `paged-mode` or `print-mode` is set, so the PDF export and the print
 * handout carry no tools at all regardless of any flag.
 *
 * Bare `?safe` as well as `?safe=true`, like every other flag the deck reads --
 * see `chat/url.js`, which is the one place that acceptance list lives.
 */
export const writesEnabled = () => !flag("safe");

/**
 * Run one tool, turning anything it throws into an MCP error rather than a
 * rejected promise.
 *
 * A tool that throws is a tool the host reports as a transport failure, which
 * reads to the agent as "the deck is broken" rather than "that did not work".
 * `apply.js` has the same posture for the same reason: a bad op is a message,
 * not a crash.
 */
const guard = (tool) => async (args) => {
  try {
    return await tool.execute(args ?? {});
  } catch (error) {
    return {
      isError: true,
      content: [
        { type: "text", text: `${tool.name} failed: ${error.message}` },
      ],
    };
  }
};

let installed = false;

/**
 * The tools as registered, for the in-page inspector.
 *
 * `registerTool` is the whole page-facing API -- there is no `listTools` coming
 * back the other way, because enumeration is the AGENT's side of the protocol.
 * So a UI in the page that wants to show what it registered has to remember,
 * and this is the remembering. `call` is the same `guard()`ed function the host
 * got, not a second path to the same tool: the inspector and the agent are
 * running identical code, which is the only version of this worth demoing.
 *
 * `group` is inspector-only. The three arrays already mean something -- read,
 * move, change -- and that grouping is the first thing a person needs in a list
 * of tool names.
 */
let registry = [];

export const getTools = () => registry;

/**
 * Register the deck's tools, and leave a console harness behind either way.
 *
 * Returns a teardown, matching `mountChat()`. There is no unregister in the API
 * the deck teaches, so the registrations themselves outlive it -- but everything
 * this module DID start, it stops: the harness, the registry, the watchdog's
 * observer, and the `installed` latch. A teardown that leaves the latch set makes
 * the next install a silent no-op, which is a worse failure than not tearing down
 * at all because it looks like success.
 */
export const installTools = () => {
  if (installed) return () => {};
  installed = true;

  // `installEditTools()` also starts the watchdog, and hands back the `stop` that
  // the teardown below owes it. Under `?safe` neither is constructed: having
  // nothing to register is a stronger guarantee than registering nothing, and it
  // also means no `MutationObserver` on the slide portal.
  let stopWatchdog = () => {};
  const groups = [
    { group: "read", tools: READ_TOOLS },
    { group: "navigate", tools: NAV_TOOLS },
  ];
  if (writesEnabled()) {
    const edit = installEditTools();
    stopWatchdog = edit.stop;
    groups.push({ group: "edit", tools: edit.tools });
  }

  // ONE PASS, ONE `guard()` PER TOOL: `call` is the guarded function and `tools` IS the
  // registry, rather than a parallel list that would wrap each tool a second time.
  registry = groups.flatMap(({ group, tools: list }) =>
    list.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      group,
      call: guard(tool),
    })),
  );
  const tools = registry;

  const teardown = () => {
    stopWatchdog();
    registry = [];
    installed = false;
    delete window.deckMcp;
  };

  // THE HARNESS GOES UP EVEN WITH NO HOST. "Are the tools right" and "is the
  // extension connected" fail in ways that look identical from the console, and
  // separating them is the difference between debugging one thing and two.
  window.deckMcp = {
    list: () =>
      tools.map(({ name, description, inputSchema }) => {
        // `?? {}` as well as `?.`: a tool with an `inputSchema` but no `properties`
        // would otherwise throw out of `deckMcp.list()` -- the one call anybody
        // makes first, and the worst place to fail.
        const params = Object.keys(inputSchema?.properties ?? {}).join(", ");
        const caller = params ? `({ ${params} })` : `()`;
        return {
          short: `${name}${caller}`,
          name,
          description,
          inputSchema,
        };
      }),
    call: (name, args) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no such tool: ${name}`);
      return tool.call(args);
    },
    // The declared shape of a tool's `structuredContent`. Exposed so the
    // contract can be CHECKED against what the tool actually returns -- a value
    // the code emits and the schema does not list is a result a strict host is
    // entitled to reject, and that drift is invisible from either side alone.
    schema: (name) => tools.find((t) => t.name === name)?.outputSchema ?? null,
    writes: writesEnabled(),
    host: !!getModelContext(),
  };

  const mc = getModelContext();
  if (!mc?.registerTool) {
    // A note, not a warning, and once. No host is the ordinary case on a laptop
    // that has not opted in, and the deck is unaffected either way.
    console.info(
      `[mcp] no modelContext; ${tools.length} tools available on window.deckMcp only`,
    );
    return teardown;
  }

  for (const tool of tools) {
    mc.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // The SAME guarded function the harness calls, not a second wrapping of the
      // same tool. Two wrappers behave identically, but only one of them can be
      // the thing a console session is exercising.
      execute: tool.call,
    });
  }

  console.info(
    `[mcp] registered ${tools.length} tools${writesEnabled() ? "" : " (read-only: ?safe)"}`,
  );

  return teardown;
};
