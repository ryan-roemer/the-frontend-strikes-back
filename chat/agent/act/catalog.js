/**
 * The registered tools, as something a 2B model can read in one breath.
 *
 * DERIVED FROM THE REGISTRY, NEVER HAND-WRITTEN. `mcp/index.js` already remembers what it
 * registered, and that list is what a real WebMCP host discovers. Writing a second
 * description of the same eight tools here would drift the moment either side changed, and
 * the drift would be invisible: the model would be told about an argument that no longer
 * exists and refuse to believe the refusal. So the catalog is a PROJECTION of the
 * registry, and a tool that is not registered cannot appear in it.
 *
 * That also makes `?safe` free. Under it `installTools()` never constructs the editing
 * tools, so they are absent from the registry, so they are absent from here, so the model
 * is not merely discouraged from editing -- it has never heard of editing.
 *
 * THE BUDGET IS WHY THIS IS NOT JUST `JSON.stringify(registry)`. The descriptions in
 * `mcp/tools.js` are written for an agent with room to read: `find_nodes` opens with three
 * sentences, `style_node` lists fourteen CSS properties. Measured on the eight registered
 * tools:
 *
 *   `JSON.stringify(registry, null, 2)`   9,188 chars   ~2,010 tok
 *   this                                  2,863 chars     ~626 tok
 *   this, under `?safe` (four tools)      1,438 chars     ~315 tok
 *
 * The full figure grew from ~540 when `edit_text` earned a third example and a first
 * sentence that names all three of its modes -- both bought by a bug, and both measured
 * with `window.deckReplay.prompt()` rather than estimated.
 *
 * Token figures are chars/4.57, the ratio implied by `prompt.js`'s own measured ~680 for
 * the pre-tools preface, rather than a tokenizer this page does not have when the prompt
 * is built. On LiteRT the whole preface is re-prefilled every turn, so the difference is
 * paid on every single answer -- including the pure Q&A turns that never call a tool.
 *
 * What is kept is what a model needs to CHOOSE: the name, one sentence of purpose, the
 * argument names, which are required, and every enum in full. What is dropped is the prose
 * that justifies the design to a human reader. Enums are never abbreviated -- they are the
 * cheapest constraint available on a runtime with no grammar-constrained decoding, which
 * is the whole argument `mcp/tools.js` makes for having them.
 */
import { getTools } from "../../mcp/index.js";
import { fieldsOf, summarize } from "../../mcp/schema.js";

/**
 * One argument, as `name` / `name?` / `name(a|b|c)`.
 *
 * `?` MARKS THE OPTIONAL ONE, not the required one, because most arguments here are
 * optional and marking the majority is noise. It is the inverse of how `tools/form.js`
 * renders the same schema for a human -- a form marks required fields with `*` because a
 * person is filling every box in front of them, while a model is choosing which boxes to
 * mention at all.
 */
const argText = (field) => {
  const name = field.required ? field.name : `${field.name}?`;
  return field.options ? `${name}(${field.options.join("|")})` : name;
};

/**
 * The signature line, then the purpose.
 *
 * `summarize()` comes from `mcp/schema.js`, which the inspector reads too. It takes the
 * first sentence of a description written for a model, without cutting "a node id like
 * '9.3'" at the decimal point. Sharing it means the inspector and the in-page model
 * summarise the same text the same way, and there is one regex to get right rather than
 * two.
 */
const toolText = (tool) => {
  const fields = fieldsOf(tool.inputSchema);
  const args = fields.map(argText).join(", ");
  return `${tool.name}(${args})\n  ${summarize(tool.description)}`;
};

/**
 * WORKED EXAMPLES, because the argument that decides the answer is not always the one
 * the model reads.
 *
 * Each of these is a case where the compact signature above is true but not sufficient,
 * and every one was picked from a real request rather than invented:
 *
 *   - `edit_text` replaces across the WHOLE DECK when neither `target` nor `slide` is
 *     given. That is the third sentence of a five-sentence description, and it is
 *     precisely what "replace all instances of X" needs. A model that fills in `target`
 *     out of caution silently narrows the request to one node and reports success.
 *   - `style_node` takes CSS declarations, and several at once. "Yellow and underline" is
 *     one request; showing the semicolon is what keeps it one call.
 *   - A target may be a phrase. The signature says `target` is a string and cannot say
 *     that "the second bullet" is a legal value for it.
 *   - `go_to_slide` has three mutually exclusive arguments, and `move` is the one a
 *     relative instruction needs.
 *   - REWRITING a whole piece of text is `target` + `text` with NO `find`, which is the
 *     FIRST mode `edit_text`'s description names and the one the model had never seen. The
 *     other two examples of that tool both pass `find`, so every piece of evidence it had
 *     said "this tool means find-and-replace". Asked to replace a heading it therefore
 *     reached for `find`, quoted the whole existing title to have something to match, and
 *     then wrote a replacement anchored on the phrase it had just quoted -- decorating the
 *     old title instead of replacing it. Paired deliberately with the removal example
 *     below: read together, they are the presence and absence of `find` on the same
 *     `target`, which is the distinction neither one teaches alone.
 *   - REMOVING text is `edit_text` with an empty `text`, and nothing above can say so.
 *     `toolText` gives the model the FIRST SENTENCE of a description, so the sentence in
 *     `mcp/tools.js` that explains deletion never reaches it -- what it sees is
 *     `edit_text(target?, slide?, find?, text)` and "Change or remove wording on the
 *     deck." Asked to remove a phrase it would omit `text` (refused: "Give me the new
 *     text.") or replace the phrase with itself and report success. The example also
 *     carries the other half of that request -- a `target` ALONGSIDE `find` scopes the
 *     replace to one node, which is what "in just the heading" means and what the
 *     deck-wide example above does not show.
 *
 * THREE OF THE SIX ARE `edit_text`, which looks unbalanced and is the honest allocation:
 * it is the only tool here with four arguments and three distinct modes, and it is the tool
 * every failure found so far has been in. The other five tools each have one obvious way to
 * be called and need no example at all.
 *
 * Each is one line, because examples are the most expensive tokens in this block: they are
 * re-prefilled every turn like everything else. The bar for a seventh is the bar the last
 * two cleared -- a request that went wrong in front of somebody, not one that might.
 *
 * FILTERED AGAINST THE REGISTRY BELOW, and that is not defensive tidying -- it was a bug.
 * Three of these four call editing tools, which `?safe` does not register, so under that
 * flag the model was shown worked examples of three tools it had never been given and
 * would call one and be told it does not exist. The rule this module opens with -- a tool
 * that is not registered cannot appear here -- has to hold for the examples too, or it is
 * not a rule.
 */
const EXAMPLES = [
  ["go to the last slide", "go_to_slide", '{"move": "last"}'],
  [
    "replace every mention of WebMCP with AWESOME",
    "edit_text",
    '{"find": "WebMCP", "text": "AWESOME"}',
  ],
  [
    "make this list yellow and underline it",
    "style_node",
    '{"target": "the bullets", "style": "color: yellow; text-decoration: underline"}',
  ],
  [
    "replace the heading with 3 rocket emojis",
    "edit_text",
    '{"target": "the heading", "text": "🚀 🚀 🚀"}',
  ],
  [
    "remove WebMCP from the heading",
    "edit_text",
    '{"target": "the heading", "find": "WebMCP", "text": ""}',
  ],
  ["undo that", "undo_edits", '{"scope": "last"}'],
];

const exampleText = ([said, name, args]) =>
  `"${said}"\n\`\`\`tool ${name}\n${args}\n\`\`\``;

/**
 * The tool block's opening fence, and the one string that has to agree in three places.
 *
 * The prompt tells the model to emit it, `parse.js` looks for it, and `respond.js` sniffs
 * the first few characters of the stream for it to decide whether to render a turn or
 * suppress it. Three modules with three copies of "```tool" is three chances to change two
 * of them.
 */
export const FENCE = "```tool";

/**
 * How to call a tool, and when not to.
 *
 * THE WHOLE REPLY, OR NONE OF IT. A model that can wrap a tool call in an explanation
 * forces `respond.js` to extract one from mid-stream, which means buffering an unknown
 * amount of prose against the chance that a fence is coming. Requiring the block to be the
 * entire reply makes the decision from the first eight characters and the suppression
 * exact -- and it costs nothing, because the tool's own receipt is what gets rendered
 * anyway (see `receipt.js`).
 *
 * "DO NOT DESCRIBE THE TOOL" is here because it is the failure a small model actually has.
 * Asked to go to the last slide it will happily answer "I'll use the go_to_slide tool to
 * navigate there" -- fluent, correct about its intention, and nothing moves.
 */
const RULES = [
  "",
  "<tools>",
  "This page gives you tools that read, move and change the deck you are running inside.",
  "When the user asks you to DO something to the deck — move it, find something, change wording, restyle, undo — call a tool.",
  "When they ask a question you can answer from the deck outline and slides above, just answer. Do not call a tool for that.",
  "",
  "To call one, your ENTIRE reply must be a single block in this form and nothing else — no explanation before or after:",
  "```tool tool_name",
  '{"argument": "value"}',
  "```",
  "",
  "Do not describe the tool you would use, and do not say you are about to call it. Emit the block and stop.",
  "Only ever call one tool at a time. Only use a tool listed below, with the arguments listed for it.",
  "Anything you change is live on the running deck and the user can see it immediately.",
];

/**
 * The catalog, or `null` when there is nothing to say.
 *
 * NULL RATHER THAN AN EMPTY SECTION. With no registered tools -- paged output, or a
 * teardown -- an empty `<tools>` block would still spend its framing tokens telling the
 * model about a capability it does not have, which is worse than silence because it
 * invites a call that cannot be answered.
 */
export const catalogText = () => {
  const tools = getTools();
  if (!tools.length) return null;

  const registered = new Set(tools.map((tool) => tool.name));
  const examples = EXAMPLES.filter(([, name]) => registered.has(name));

  return [
    ...RULES,
    "",
    "The tools:",
    "",
    ...tools.map(toolText),
    // Under `?safe` only the navigation example survives; with nothing registered that an
    // example covers, the heading would introduce an empty list.
    ...(examples.length
      ? ["", "Examples:", "", ...examples.map(exampleText)]
      : []),
    "</tools>",
  ].join("\n");
};

/**
 * A name the model wrote -> the tool it meant.
 *
 * EXACT FIRST, THEN FORGIVING, and the forgiving pass only collapses the punctuation a
 * model gets wrong for reasons that have nothing to do with intent: `style-node`,
 * `styleNode`, `style node`, a stray backtick. Case and separators, nothing else.
 *
 * DELIBERATELY NOT FUZZY. Edit distance would map `undo_edits` onto `edit_text` at a
 * distance nobody would call far, and a mis-dispatch is silent -- it does the wrong thing
 * to the deck and reports success. An unrecognised name has a good failure available
 * (`respond.js` says so and lists the real ones); a confidently wrong one does not.
 */
const key = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export const byName = (name) => {
  const tools = getTools();
  const said = String(name ?? "").trim();
  return (
    tools.find((tool) => tool.name === said) ??
    tools.find((tool) => key(tool.name) === key(said)) ??
    null
  );
};

/** Every registered name, for the message that follows a miss. */
export const toolNames = () => getTools().map((tool) => tool.name);
