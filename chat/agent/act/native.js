/**
 * The registered tools, as declarations a runtime can call itself.
 *
 * THE OTHER HALF OF `catalog.js`. A provider whose runtime parses tool calls out of the
 * model's own template -- LiteRT-LM's `AutoToolChat` -- does not need the fenced-block
 * convention, the parser, or the correction pass. It needs each tool's name, a description
 * and a schema, plus an `execute` it can call between decode rounds. That is the WebMCP
 * tool shape, which `AutoToolChat` accepts as-is.
 *
 * DERIVED FROM THE REGISTRY, for the same reason the catalog is: a second description of
 * the same tools would drift, and under `?safe` the editing tools are never registered, so
 * they are never declared either.
 *
 * `execute` RUNS THE SAME `guard()`ed FUNCTION as everything else. The prompted path, the
 * inspector and a WebMCP host all call `tool.call`, and so does this. What differs is only
 * who decided to make the call.
 */
import { getTools } from "../../mcp/index.js";
import { summarize } from "../../mcp/schema.js";
import { MIN_SUMMARY } from "./catalog.js";
import { invalidate } from "./invalidate.js";
import { textOf } from "./receipt.js";

/**
 * JSON Schema keywords LiteRT-LM's `Schema` type has no field for.
 *
 * `minimum` is the only one the deck's tools use today. The tool itself still enforces it,
 * so dropping it from the declaration loses a hint and nothing else.
 */
const UNSUPPORTED = new Set(["minimum", "maximum", "exclusiveMinimum"]);

const stripSchema = (schema) =>
  JSON.parse(
    JSON.stringify(
      schema ?? { type: "object", properties: {} },
      (key, value) => (UNSUPPORTED.has(key) ? undefined : value),
    ),
  );

/**
 * What the model reads back after a call.
 *
 * TEXT AND A FLAG, NOT THE WHOLE MCP RESULT. The text blocks are finished sentences
 * written for exactly this reader, and they already carry the candidates a refusal hands
 * back ("matches 3 nodes. Call again with one of these ids: ..."). `structuredContent`
 * repeats the same facts as data, which costs tokens and tells a 2B model nothing new.
 *
 * `ok: false` also makes the refusal read as the deck's answer to a call rather than as the
 * user withdrawing the capability, which was the failure `retryText` in `receipt.js` exists
 * to avoid on the prompted path. A tool response is already the right framing here.
 */
const forModel = (result) => ({
  ok: !result?.isError,
  result: textOf(result) || (result?.isError ? "The tool refused." : "Done."),
});

/**
 * The declarations for one turn.
 *
 * `onCall` receives `{ name, args, result }` after each call, with the full MCP result, so
 * `respond.js` can build the same receipt the prompted path shows. Per turn rather than
 * once at mount, because the receipt belongs to the turn that made the call.
 *
 * Descriptions use the catalog's `summarize()` floor. The runtime renders every
 * declaration into the preface, and the full descriptions cost ~2,010 tokens across eight
 * tools on every turn. Argument descriptions are kept whole: they carry the details a
 * small model gets wrong without them ("1-based", "Omit to act on a whole slide").
 */
export const nativeTools = ({ onCall } = {}) =>
  getTools().map((tool) => ({
    name: tool.name,
    description: summarize(tool.description, { atLeast: MIN_SUMMARY }),
    inputSchema: stripSchema(tool.inputSchema),
    execute: async (args) => {
      const result = await tool.call(args ?? {});
      invalidate(tool.name, result);
      onCall?.({ name: tool.name, args: args ?? {}, result });
      return forModel(result);
    },
  }));

/**
 * The system prompt's tool section, for a runtime that declares the tools itself.
 *
 * NO FORMAT AND NO LIST. The runtime renders the declarations through the model's own tool
 * template, so describing a call syntax here would be a second, conflicting one. What is
 * left is the part a template cannot say: when to reach for a tool at all, and that the
 * result is already on screen.
 */
export const nativeRulesText = () =>
  getTools().length
    ? [
        "",
        "<tools>",
        "This page gives you tools that read, move and change the deck you are running inside.",
        "When the user asks you to DO something to the deck — move it, find something, change wording, restyle, undo — call a tool.",
        "When they ask a question you can answer from the deck outline and slides above, just answer. Do not call a tool for that.",
        "Anything you change is live on the running deck. The user sees each tool's result as soon as it runs, so after a tool call reply with one short sentence, or nothing.",
        "</tools>",
      ].join("\n")
    : null;
