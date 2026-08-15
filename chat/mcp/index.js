/* global console:false, document:false, navigator:false, URLSearchParams:false, window:false */

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
import { getSnapshot } from "../bus.js";
import { installEditTools, READ_TOOLS, NAV_TOOLS } from "./tools.js";

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
 * Whether the deck may be CHANGED, not whether tools exist.
 *
 * Reading and navigating are registered always: an agent connected during the
 * actual talk should be able to follow along and move the deck, and neither can
 * damage anything. Writing is opt-in, because the alternative is a stray tool
 * call rewriting a slide in front of an audience.
 *
 * Bare `?mcp` as well as `?mcp=true`, following `chat/state.js`: a flag you have
 * to remember the value of is a flag you will get wrong at the podium.
 */
const editingEnabled = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("mcp")) return false;
    const value = params.get("mcp");
    return value === null || value === "" || value === "true" || value === "1";
  } catch {
    return false;
  }
};

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
 * Register the deck's tools, and leave a console harness behind either way.
 *
 * Returns a teardown, matching `mountChat()`. There is no unregister in the API
 * the deck teaches, so teardown only drops the harness -- honest rather than
 * pretending the tools went away.
 */
export const installTools = () => {
  if (installed) return () => {};
  installed = true;

  const tools = [...READ_TOOLS, ...NAV_TOOLS];
  if (editingEnabled()) tools.push(...installEditTools());

  // THE HARNESS GOES UP EVEN WITH NO HOST. "Are the tools right" and "is the
  // extension connected" fail in ways that look identical from the console, and
  // separating them is the difference between debugging one thing and two.
  window.deckMcp = {
    list: () =>
      tools.map(({ name, description, inputSchema }) => {
        const params = Object.keys(inputSchema?.properties).join(", ");
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
      return guard(tool)(args);
    },
    // The declared shape of a tool's `structuredContent`. Exposed so the
    // contract can be CHECKED against what the tool actually returns -- a value
    // the code emits and the schema does not list is a result a strict host is
    // entitled to reject, and that drift is invisible from either side alone.
    schema: (name) => tools.find((t) => t.name === name)?.outputSchema ?? null,
    editing: editingEnabled(),
    host: !!getModelContext(),
  };

  const mc = getModelContext();
  if (!mc?.registerTool) {
    // A note, not a warning, and once. No host is the ordinary case on a laptop
    // that has not opted in, and the deck is unaffected either way.
    console.info(
      `[mcp] no modelContext; ${tools.length} tools available on window.deckMcp only`,
    );
    return () => delete window.deckMcp;
  }

  for (const tool of tools) {
    mc.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: guard(tool),
    });
  }

  console.info(
    `[mcp] registered ${tools.length} tools${editingEnabled() ? " (editing enabled)" : ""}`,
  );

  return () => delete window.deckMcp;
};

/**
 * Whether the deck is reachable yet.
 *
 * Exported for tools rather than used here: `installTools` runs before React
 * commits, so anything reading `getSnapshot()` at install time sees an empty
 * deck. Every tool reads it inside `execute` instead.
 */
export const deckReady = () => getSnapshot().ready;
