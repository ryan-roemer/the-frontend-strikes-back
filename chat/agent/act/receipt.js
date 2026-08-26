/**
 * A tool result -> what the user reads.
 *
 * THE RECEIPT IS THE ANSWER. This is the decision the whole layer is built around, so it
 * is worth stating plainly: when the model calls a tool, the tool's own text block becomes
 * the assistant's reply, and the model is not asked to narrate it.
 *
 * That is not a shortcut taken to save a round trip. It is what `mcp/tools.js` was already
 * built for. `mutate()`'s receipts "describe what was applied, never what was asked for";
 * `landed()` reports the slide the deck actually reached rather than the one requested;
 * `setStyles` reports the pixel value the slide got rather than the word "bigger" it was
 * given. Those are finished English sentences, written by code that watched the change
 * happen. Handing them to a 2B model to be said again buys nothing and costs twice:
 *
 *   LATENCY   a second turn re-prefills the whole preface. ~1.6s on LiteRT before a
 *             token, on top of the call that has already run.
 *   TRUTH     it is the only step in the turn that can lie. A model asked to summarise
 *             "Moved: slide 35 of 35" will sometimes report slide 34, and a presenter
 *             reading the transcript has no reason to doubt it.
 *
 * So the model's job ends at choosing the tool and filling its arguments. Everything after
 * that is deterministic, which is the same argument `harvest/locate.js` makes for
 * resolving phrases in JS rather than in the model.
 *
 * MARKDOWN, NOT A COMPONENT, and that is what keeps `use-conversation.js` and
 * `ui/transcript.js` untouched by any of this. A tool receipt is a string that arrives
 * through the same `onChunk` an answer does, so the transcript does not need to know tools
 * exist. `agent/markdown.js` already renders bold, code spans and bullets, which is every
 * mark used here.
 */

/** The text blocks of an MCP result, joined. The shape `examples/tool-handler.js` defines. */
const textOf = (result) =>
  (result?.content ?? [])
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();

/**
 * The call itself, shown above its result.
 *
 * SHOWN RATHER THAN HIDDEN, because this is a talk about tool calling and the call is the
 * thing being demonstrated. It is also the only way a presenter can tell a tool that did
 * nothing from a model that called the wrong tool, which are the two failures that look
 * identical from the receipt alone.
 *
 * Arguments are re-serialised from the PARSED object rather than echoed from the model's
 * raw text, so what is displayed is what was actually dispatched. A model that wrote a
 * trailing comma should not have its typo shown as though the deck received it.
 */
export const callLine = (name, args) => {
  const shown = args && Object.keys(args).length ? JSON.stringify(args) : "";
  return `\`${name}(${shown})\``;
};

/**
 * A finished tool turn, as one transcript bubble.
 *
 * THE ERROR MARK IS A WORD, NOT A COLOUR. A refusal that reads like a success is the
 * failure `edit/apply.js` calls the receipt lie, and it survives right up to here: `ok()`
 * and `fail()` in `mcp/tools.js` both produce a text block, and the only thing separating
 * them is `isError`. Rendering both as plain prose would put "There is no chapter 9." in
 * the transcript looking exactly like "Moved to chapter 3."
 */
export const receiptText = (name, args, result) => {
  const said = textOf(result);
  const head = callLine(name, args);

  if (result?.isError) {
    return `${head}\n\n**Couldn't do that.** ${said || "The tool refused without saying why."}`;
  }

  // No lead-in on success. The receipt already opens with what happened -- "Moved: slide 35
  // of 35", "color: yellow on the bullets" -- and prefixing it with "Done:" says the same
  // thing twice in less specific words.
  return said ? `${head}\n\n${said}` : `${head}\n\nDone.`;
};

/**
 * Whether a refusal is worth a second model call.
 *
 * THE ONE CASE WHERE THE LOOP EARNS ITS ROUND TRIP. `target.js` refuses an ambiguous
 * phrase by handing back the candidates it could not choose between, and that is genuinely
 * new information: the model asked for "the TODO", learned there are three, and can now
 * pick one by id. Every other refusal is terminal -- a bad slide number, an unusable CSS
 * value, a deck-wide replace over the limit -- and re-asking a 2B model to think again
 * about the same facts produces the same call, one preface later.
 *
 * Read from `structuredContent`, not from the prose. The candidates are in both, which is
 * exactly why `mcp/shape.js` exists, and the structured copy is the one that cannot be
 * mis-parsed.
 */
export const retryable = (result) => {
  if (!result?.isError) return false;
  const structured = result.structuredContent;
  // Candidates, or a tool that said so itself. `retry: true` is the explicit opt-in --
  // set by `go_to_slide` when a `move` was not one of its moves, because it can name the
  // whole valid set and a model handed that set usually gets it right second time.
  //
  // DECLARED BY THE TOOL, NOT SNIFFED FROM THE MESSAGE. Guessing "does this refusal look
  // recoverable?" from prose would make every message edit a silent behaviour change,
  // and the tool is the only thing that knows whether it withheld something useful.
  return !!structured?.candidates?.length || structured?.retry === true;
};
