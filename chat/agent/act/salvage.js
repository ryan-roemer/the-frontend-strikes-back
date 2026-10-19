/**
 * Tool calls rescued from a reply the runtime could not parse.
 *
 * NO IMPORTS, so `test/salvage.test.js` can feed it the real error under plain Node --
 * `native.js` reaches Spectacle through the registry and cannot load there.
 */
/**
 * The calls inside a reply LiteRT-LM.js could not parse, or null.
 *
 * WHY THE DECK READS THEM ITSELF. Gemma's template delimits a string argument with the
 * `<|"|>` token, and the runtime's parser accepts nothing else. Asked to "change the heading
 * of this slide to Bye!", the model answered
 * `call:edit_text{find: "Thanks!", slide: 24, text: "Bye!"}` -- the right tool, the right
 * phrase, the right slide, in ASCII quotes -- and the whole turn died as a parser dump in
 * the error row. The call was fine; only the quoting was not, and the examples `native.js`
 * shows are written with ASCII quotes, so the model has been shown both.
 *
 * THE ERROR CARRIES THE REPLY ("... full response: <|tool_call>call:...<tool_call|> error:
 * ..."), so nothing has to be re-asked. Read leniently -- either quote, bare or quoted keys
 * -- and only as far as the deck's tools need: every argument is a flat scalar. Anything
 * this cannot read with certainty returns null and the original error stands. The tool
 * still validates what it gets, through the same `execute` as every other call.
 *
 * Returns `[{ tool, args }]` for calls to tools in `tools`, in the order they were made.
 */
const PARSE_FAILED = /Failed to parse tool calls/;
const CALL = /<\|tool_call>\s*call:([\w-]+)\{([\s\S]*?)\}\s*<tool_call\|>/g;
const TOKEN_QUOTE = '<|"|>';

/** One `key: value, ...` body as an object, or null at the first thing it cannot read. */
const readArgs = (body) => {
  const args = {};
  let i = 0;
  const space = () => {
    while (/\s/.test(body[i] ?? "")) i++;
  };
  // A string in either delimiter. ASCII-quoted is read as JSON, so escapes mean what the
  // model meant by them; token-quoted is raw, as the template defines it.
  const string = () => {
    if (body.startsWith(TOKEN_QUOTE, i)) {
      const end = body.indexOf(TOKEN_QUOTE, i + TOKEN_QUOTE.length);
      if (end < 0) return undefined;
      const value = body.slice(i + TOKEN_QUOTE.length, end);
      i = end + TOKEN_QUOTE.length;
      return value;
    }
    if (body[i] !== '"') return undefined;
    let j = i + 1;
    while (j < body.length && body[j] !== '"') j += body[j] === "\\" ? 2 : 1;
    if (j >= body.length) return undefined;
    try {
      const value = JSON.parse(body.slice(i, j + 1));
      i = j + 1;
      return value;
    } catch {
      return undefined;
    }
  };
  const key = () => {
    const quoted = string();
    if (quoted !== undefined) return quoted;
    const bare = /^[A-Za-z_]\w*/.exec(body.slice(i))?.[0];
    if (bare) i += bare.length;
    return bare;
  };
  const scalar = () => {
    const quoted = string();
    if (quoted !== undefined) return quoted;
    const word = /^(-?\d+(\.\d+)?|true|false|null)/.exec(body.slice(i))?.[0];
    if (!word) return undefined;
    i += word.length;
    return JSON.parse(word);
  };

  space();
  while (i < body.length) {
    const name = key();
    space();
    if (!name || body[i] !== ":") return null;
    i++;
    space();
    const value = scalar();
    if (value === undefined) return null;
    args[name] = value;
    space();
    if (i < body.length && body[i++] !== ",") return null;
    space();
  }
  return args;
};

export const salvageCalls = (err, tools) => {
  const message = String(err?.message ?? "");
  if (!PARSE_FAILED.test(message)) return null;
  const reply = message.split("full response:")[1] ?? "";
  const calls = [];
  for (const [, name, body] of reply.matchAll(CALL)) {
    const tool = tools.find((candidate) => candidate.name === name);
    const args = tool && readArgs(body);
    if (!args) return null;
    calls.push({ tool, args });
  }
  return calls.length ? calls : null;
};
