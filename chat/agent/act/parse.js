/**
 * What the model wrote -> the call it meant, or nothing.
 *
 * PURE, AND THE ONLY MODULE HERE WITH NO IMPORTS. Everything tolerant lives in this one
 * file, deliberately: parsing untrusted generated text is where a tool layer rots, and
 * keeping it a string-in, object-out function means every failure mode can be exercised as
 * a table of strings with no model, no deck and no session. That is the property worth
 * protecting -- the alternative is discovering the quirk on stage.
 *
 * THE NAME IS OUTSIDE THE JSON, which is the format's one real design decision:
 *
 *     ```tool style_node
 *     {"target": "the bullets", "style": "color: yellow"}
 *     ```
 *
 * The tool name is the single value most likely to come out slightly wrong, and putting it
 * on the fence's info string means recovering it never depends on the JSON parsing. A
 * model that writes malformed JSON has still told us unambiguously which tool it wanted,
 * which is the difference between "style_node needs a `style` argument" and "I could not
 * read that" -- and the first of those is a message the model can act on.
 *
 * The arguments stay JSON because they have to carry free text. "Replace all instances of
 * WebMCP with 'AWESOME'" puts a quoted string with spaces inside an argument, and every
 * lighter-weight syntax (`key=value` lines, colon pairs) needs quoting rules the moment it
 * meets one -- at which point it is JSON with a worse parser.
 *
 * RETURNS `null` FOR "NOT A TOOL CALL", and that is the common case rather than an error:
 * most turns are questions, and their answers are prose that must pass through untouched.
 */

/** The fence a tool call opens with. Mirrors `catalog.FENCE`; see the note there. */
const OPEN = /```[ \t]*tool[ \t]*([A-Za-z0-9_.\- ]*)\r?\n/;

/**
 * The head of a reply, with the variation that carries no meaning taken out.
 *
 * SNIFFING AND PARSING MUST AGREE, and this is the only reason this function exists.
 * They did not: `OPEN` tolerates "``` tool" while a literal prefix comparison does not, so
 * a model that put a space after the backticks got its block streamed into the transcript
 * as prose AND parsed as a call -- rendering the raw fence to the user, then acting. Two
 * near-copies of one rule is one of them being wrong, so both now start here.
 *
 * Leading whitespace and the space between the fence and `tool` are both noise a model
 * varies for no reason. Case is folded for the same reason.
 */
const head = (text) =>
  String(text ?? "")
    .replace(/^\s+/, "")
    .replace(/^(```)[ \t]+/, "$1")
    .toLowerCase();

/**
 * Enough of the stream to tell a tool call from an answer.
 *
 * Called on the first chunks by `respond.js`, which needs to decide whether to render
 * before it knows what the whole reply is. Three states, and the third is why this is not
 * just a boolean: a reply that has produced nothing but whitespace and a backtick is not
 * yet an answer OR a call, and treating "unknown" as "answer" would flash the opening
 * fence into the transcript before suppressing it.
 *
 * Compared against a PREFIX of the fence rather than the whole thing, so a partial "``"
 * is held rather than released and then retracted.
 */
export const sniff = (text) => {
  const said = head(text);
  if (!said) return "unknown";
  // The longest prefix worth waiting on. Past this a fence has either declared itself or
  // cannot: "```too" can still become a tool call, "```js" never will.
  const probe = "```tool";
  if (said.length < probe.length) {
    return probe.startsWith(said) ? "unknown" : "answer";
  }
  return said.startsWith(probe) ? "call" : "answer";
};

/**
 * Find the JSON object in a block body.
 *
 * BRACE MATCHING, NOT A REGEX, because the arguments contain free text and free text
 * contains braces -- `{"text": "use {} for an empty object"}` is a legal thing to ask this
 * deck to say, and a lazy `/\{.*\}/s` would either stop at the wrong brace or swallow the
 * closing fence. Strings are tracked so that a brace inside one does not count, and
 * escapes are tracked so that a `\"` does not end the string.
 *
 * Returns the first balanced object, which is also the only one worth having: the prompt
 * asks for exactly one call, and a second object in the same block is a model that has
 * ignored that instruction rather than a second call to honour.
 */
const firstObject = (body) => {
  const start = body.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i += 1) {
    const char = body[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }

  // Unbalanced: the model ran out of tokens, or lost count. Either way there is no
  // object here, and guessing a closing brace guesses the arguments too.
  return null;
};

/**
 * Repairs that cannot change what was meant.
 *
 * A DELIBERATELY SHORT LIST, and the test each entry has to pass is that a human reading
 * the before and after would say they are the same request. Trailing commas and smart
 * quotes are typography; `'single'` for `"double"` is a model reaching for the other
 * string syntax it knows. None of those touches a value.
 *
 * What is NOT here: inserting missing quotes around bare words, closing unbalanced
 * brackets, or coercing a number that arrived as prose. Each of those invents content, and
 * an invented argument is applied to the deck and reported as a success -- the receipt lie
 * `edit/apply.js` is built to prevent, reintroduced one layer up.
 */
const repair = (json) =>
  json
    // Smart quotes, which arrive whenever the model is quoting the user's own words back.
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    // `'target': 'the bullets'` -> `"target": "the bullets"`. Only where the contents hold
    // no double quote of their own, so a single-quoted string wrapping a double-quoted one
    // is left alone rather than mangled.
    .replace(/'([^'"\\]*)'/g, '"$1"')
    // A trailing comma before the close. JSON's one genuinely surprising rule.
    .replace(/,\s*([}\]])/g, "$1");

/**
 * One reply -> `{ name, args }`, or `null`.
 *
 * `args` is `{}` rather than null when the block carries no object, because a tool that
 * takes nothing is a real case -- `get_deck_outline` -- and so is a model that omitted
 * optional arguments entirely. `execute` destructures with defaults either way.
 *
 * `raw` rides along for the message a bad parse produces. Telling the model "I could not
 * read the arguments" without showing it what it wrote leaves it to guess which of its
 * habits to change, and it usually guesses the tool name.
 */
export const parseCall = (text) => {
  const said = String(text ?? "");
  const open = OPEN.exec(said);
  if (!open) return null;

  const name = open[1].trim();
  const after = said.slice(open.index + open[0].length);
  // The closing fence, when the model produced one. When it did not -- truncated by the
  // idle timeout, or by a stop -- the rest of the reply is the body, and brace matching
  // below is what actually decides where the arguments end.
  const close = after.indexOf("```");
  const body = close === -1 ? after : after.slice(0, close);

  const json = firstObject(body);
  if (!json) {
    // AN EMPTY BODY IS NOT A FAILED PARSE. `get_deck_outline` takes nothing, and a model
    // that omitted every optional argument wrote a legal call -- `{}` dispatches and
    // `execute` destructures its defaults. Body with content and no object is the other
    // thing entirely: an array, a bare string, a half-written brace. Reporting that as
    // `{}` dispatched the tool with no arguments and blamed the refusal on the tool.
    return body.trim()
      ? { name, args: null, raw: body.trim() }
      : { name, args: {}, raw: "" };
  }

  for (const candidate of [json, repair(json)]) {
    try {
      const parsed = JSON.parse(candidate);
      // An array or a string is valid JSON and not an argument object. Passing one to
      // `execute` destructures to all-undefined and the tool refuses with a message about
      // the wrong thing entirely.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { name, args: parsed, raw: json };
      }
    } catch {
      // Try the repaired form; if that also throws, fall through to the report below.
    }
  }

  return { name, args: null, raw: json };
};
