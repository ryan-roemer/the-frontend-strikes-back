/* global DOMException:false, console:false, setTimeout:false, clearTimeout:false */
import { generate } from "./providers/litert.js";

/**
 * Turning a JSON Schema into an object, without constrained decoding.
 *
 * This is the one module that knows how a schema becomes an object, and it is deliberately
 * the only one: `plan.js` and `schema.js` are untouched by the provider swap, so a future
 * change of strategy is contained here.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS LOST, AND WHAT REPLACES IT
 *
 * The Prompt API had `responseConstraint`: hand it a JSON Schema and the output was
 * schema-shaped BY CONSTRUCTION. That was not a politeness feature. `schema.js` splices the
 * live element refs, style properties, class names and CSS var names into the schema as
 * `enum`s on every turn, so a hallucinated reference was not rejected after the fact -- it
 * was undecodable. On a 2B model that is worth more than any amount of prompt wording.
 *
 * LiteRT-LM has no equivalent. Verified against the 0.15.0 type declarations, not guessed:
 * `SessionConfig` offers `samplerParams {type, k, p, temperature, seed}`, `stopTokenIds`,
 * `numOutputCandidates`, `samplerBackend` and `maxOutputTokens`, and that is all. There is no
 * grammar, no JSON schema, no response format, no logit bias. (There is a prompt-level
 * `AutoToolChat` helper under `@litert-lm/core/orchestration`, but it is unconstrained, so it
 * would buy nothing here.)
 *
 * So: render the schema into the prompt, generate, extract, validate, snap near misses, and
 * repair ONCE. The pipeline degrades honestly rather than pretending:
 *
 *   - A value that does not validate is DROPPED, never coerced into something plausible.
 *   - `chat/edit/apply.js` re-validates every op independently and refuses readably, so a
 *     field this module drops becomes a refusal rather than a wrong edit. That safety net
 *     was built before this change and is exactly why prompt-and-validate is survivable.
 *
 * ---------------------------------------------------------------------------
 * WHAT APPLY.JS ALREADY GUARANTEES -- do not duplicate it here
 *
 * Unknown ops, every enum re-checked (`STYLE_PROPS`, `CSS_VARS`, `TOGGLE_CLASSES`,
 * `HEADING_TREATMENTS`, `goto.where`, `deck_action`), empty-value rejections, conditional
 * requireds, and -- most importantly -- every ref resolved against the LIVE DOM, so a
 * hallucinated or stale ref is already a readable refusal.
 *
 * WHAT IT DOES NOT DO, which is therefore this module's actual job:
 *
 *   - TYPE COERCION. `apply.js` passes values straight through, so `on: "false"` is a truthy
 *     string and `toggle_class` would ADD the class the user asked to remove. Silent, wrong
 *     behaviour on a live deck. Constrained decoding made this impossible; without it, it is
 *     likely. This is the single most important check below.
 *   - `maxLength`. Nothing downstream enforces it, and `schema.js`'s 140-character cap is a
 *     LAYOUT guard -- the canvas is a fixed 1366x768 and long text overflows a slide silently.
 *   - Range clamping on `slideIndex`.
 *   - `additionalProperties: false`. `plan.js` does `apply({ op, ...filled })`, spreading
 *     `filled` LAST, so a reply containing `"op": "reset"` would override the routed op and
 *     wipe every edit. Stripping to declared keys is not tidiness, it is the fix.
 * ---------------------------------------------------------------------------
 */

/**
 * Per-call ceilings.
 *
 * Short, because these are small generations on a warm engine -- measured at ~120ms
 * time-to-first-token and ~70 tokens/sec decode. The old 20s ceiling here was sized for a
 * platform that never answered at all, and leaving it would have hidden a hang rather than
 * surfaced one.
 */
const ROUTE_TIMEOUT_MS = 8000;
const FILL_TIMEOUT_MS = 15000;

/** A router answer is one word. Capping output is what stops a chatty model burning seconds. */
const ROUTE_MAX_TOKENS = 8;
const FILL_MAX_TOKENS = 192;

const aborted = () => new DOMException("Aborted", "AbortError");

/**
 * Race a promise against a timeout AND the caller's abort signal.
 *
 * Both matter, and for different reasons. The timeout catches a wedged runtime; the signal is
 * how the stop button reaches code sitting inside an `await`. Without the signal here,
 * pressing stop while the router was thinking did precisely nothing -- the turn ran to
 * completion and only then noticed it had been cancelled.
 */
const guarded = (promise, label, signal, ms) => {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
    new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) return reject(aborted());
      signal.addEventListener("abort", () => reject(aborted()), { once: true });
    }),
  ]).finally(() => clearTimeout(timer));
};

/* -------------------------------------------------------------------------- */
/* Matching a value against an allowed set                                    */
/* -------------------------------------------------------------------------- */

/** `font_size` / `Font Size` / `font size` all normalise to `font-size`. */
const normalise = (value) =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

/** Classic Levenshtein, only ever consulted at a distance of 1. */
const distance = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
};

/**
 * Snap a near-miss onto an allowed value, or return null.
 *
 * The ladder is ordered so that an exact match can never be beaten by a fuzzy one, and every
 * rung REQUIRES A UNIQUE WINNER. That is the rule that makes this safe rather than clever:
 *
 *   - `text-align`, `text-transform` and `text-decoration` all contain `text-`, so a bare
 *     `text-` must fail rather than silently pick the first.
 *   - `background-color` contains `color`, so `color` has to win by exact match at rung 1 and
 *     must never reach the substring rung.
 *
 * Distance is capped at 1 for the same reason: at 2, genuinely distinct values merge.
 */
const snap = (value, allowed) => {
  if (value == null) return null;
  const raw = String(value).trim();

  // 1. Exact.
  if (allowed.includes(raw)) return raw;

  // 2. Case and separator insensitive.
  const want = normalise(raw);
  const byNormal = allowed.filter((a) => normalise(a) === want);
  if (byNormal.length === 1) return byNormal[0];

  // 3. CSS custom properties, with or without the leading dashes.
  const dashed = allowed.filter(
    (a) => normalise(a) === `--${want}`.replace(/^-+/, "--"),
  );
  if (dashed.length === 1) return dashed[0];

  // 4. Unique containment, either direction.
  const contained = allowed.filter(
    (a) => normalise(a).includes(want) || want.includes(normalise(a)),
  );
  if (contained.length === 1) return contained[0];

  // 5. One typo away, and unambiguously so.
  const near = allowed.filter((a) => distance(normalise(a), want) <= 1);
  if (near.length === 1) return near[0];

  return null;
};

/**
 * Refs are never snapped.
 *
 * They are opaque generated ids (`e1`, `e2`, ...) with no internal meaning, so every
 * distance-1 neighbour of a ref is ANOTHER REAL ELEMENT. Snapping `e3` to `e8` would edit the
 * wrong thing on a live slide and read to the audience as a deck bug rather than a model
 * mistake. `apply.js` resolves refs against the DOM and refuses cleanly, which is the right
 * outcome. Keyed on the field name because that is what `schema.js` uses for every ref field.
 */
const isRefField = (key) => key === "ref";

/* -------------------------------------------------------------------------- */
/* Rendering a schema into a prompt                                           */
/* -------------------------------------------------------------------------- */

const describe = (key, spec) => {
  if (spec.enum) {
    return isRefField(key)
      ? `one of these exact ids from the table above: ${spec.enum.join(", ")}`
      : `one of exactly: ${spec.enum.join(", ")}`;
  }
  if (spec.type === "integer" || spec.type === "number") {
    const lo = spec.minimum;
    const hi = spec.maximum;
    if (lo != null && hi != null) return `a whole number from ${lo} to ${hi}`;
    return "a whole number";
  }
  if (spec.type === "boolean") return `true or false (not "true", not 1)`;
  if (spec.type === "string") {
    return spec.maxLength
      ? `a string, at most ${spec.maxLength} characters`
      : "a string";
  }
  return "a value";
};

/**
 * The schema as instructions.
 *
 * `additionalProperties: false` is deliberately NOT mentioned. Telling a small model not to
 * add fields invites it to discuss the fields it is not adding; stripping undeclared keys in
 * the validator is free and silent.
 */
const contractFor = (schema) => {
  const properties = schema.properties ?? {};
  const lines = [
    "Reply with ONE JSON object and nothing else. No explanation, no code fence.",
    "Fields:",
  ];
  for (const [key, spec] of Object.entries(properties)) {
    lines.push(`  "${key}": ${describe(key, spec)}`);
  }
  const required = schema.required ?? [];
  if (required.length) {
    lines.push(`Every one of these must be present: ${required.join(", ")}.`);
  }
  return lines.join("\n");
};

/* -------------------------------------------------------------------------- */
/* Getting an object back out of prose                                        */
/* -------------------------------------------------------------------------- */

/**
 * Find the first balanced `{...}` and parse it.
 *
 * Brace COUNTING rather than a regex, and never `JSON.parse` on the whole reply: an
 * unconstrained Gemma habitually prefixes "Sure! Here's the JSON:" and often wraps the object
 * in a fence. Both are fine as long as we only read the object.
 */
const extractObject = (raw) => {
  if (!raw) return null;
  const text = String(raw).replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const BOOLEAN_WORDS = {
  true: true,
  yes: true,
  on: true,
  1: true,
  false: false,
  no: false,
  off: false,
  0: false,
};

/**
 * Coerce one field, or refuse it.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, why }`. Refusing is always safe: the field is
 * dropped and `apply.js` decides what a missing field means, which it already knows how to do.
 * Producing a WRONG value is the thing that must never happen.
 */
const coerce = (key, spec, value) => {
  if (spec.enum) {
    if (isRefField(key)) {
      return spec.enum.includes(value)
        ? { ok: true, value }
        : { ok: false, why: `"${key}" is not one of the ids on this slide` };
    }
    const snapped = snap(value, spec.enum);
    if (snapped == null) {
      return {
        ok: false,
        why: `"${key}" was ${JSON.stringify(value)}, which is not in the list; choose from: ${spec.enum.join(", ")}`,
      };
    }
    if (snapped !== value) {
      // Logged, always. A silent correction is the kind of thing that costs an afternoon
      // when the model's output and the applied edit disagree and nothing says why.
      console.debug(
        `[chat] snapped ${key} ${JSON.stringify(value)} -> ${JSON.stringify(snapped)}`,
      );
    }
    return { ok: true, value: snapped };
  }

  if (spec.type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    // NEVER `Boolean(value)`. The string "false" is truthy, and that single line would turn
    // "stop making the cards dense" into "make the cards dense".
    const word = BOOLEAN_WORDS[normalise(value)];
    if (typeof word === "boolean") return { ok: true, value: word };
    return { ok: false, why: `"${key}" must be true or false` };
  }

  if (spec.type === "integer" || spec.type === "number") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) {
      return { ok: false, why: `"${key}" must be a number` };
    }
    let out = spec.type === "integer" ? Math.round(n) : n;
    // Clamped HERE, before `apply.js` sees it, because receipts are generated from what was
    // applied -- `goto`'s label echoes the value it was given, so clamping afterwards would
    // print "-> slide 47" for a 35-slide deck.
    if (spec.minimum != null) out = Math.max(spec.minimum, out);
    if (spec.maximum != null) out = Math.min(spec.maximum, out);
    return { ok: true, value: out };
  }

  if (spec.type === "string") {
    if (typeof value !== "string" && typeof value !== "number") {
      return { ok: false, why: `"${key}" must be a string` };
    }
    const text = String(value).trim();
    if (!text) return { ok: false, why: `"${key}" is empty` };
    if (spec.maxLength && text.length > spec.maxLength) {
      // Rejected rather than truncated. A mid-word cut landing on a live slide in front of an
      // audience is worse than a refusal the presenter can act on.
      return {
        ok: false,
        why: `"${key}" was ${text.length} characters; the limit is ${spec.maxLength}`,
      };
    }
    return { ok: true, value: text };
  }

  return { ok: true, value };
};

/**
 * Validate an extracted object against the schema.
 *
 * Only validated values survive. Undeclared keys are dropped silently -- that is the
 * `additionalProperties: false` fix, and the reason a reply containing `"op": "reset"` cannot
 * hijack the routed op.
 */
const validateObject = (object, schema) => {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return { value: null, problems: ["the reply contained no JSON object"] };
  }

  const properties = schema.properties ?? {};
  const value = {};
  const problems = [];

  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in object) || object[key] == null) continue;
    const result = coerce(key, spec, object[key]);
    if (result.ok) value[key] = result.value;
    else problems.push(result.why);
  }

  for (const key of schema.required ?? []) {
    if (!(key in value)) problems.push(`"${key}" is missing`);
  }

  return { value, problems };
};

/**
 * Turn one raw model reply into a schema-shaped object.
 *
 * Exported because this -- not `decode` -- is the part with all the sharp edges, and it is
 * pure: a string and a schema in, a value and a list of problems out. That makes every
 * adversarial case (`on: "false"`, a 300-character `set_text`, a fenced reply with a
 * preamble, an `"op": "reset"` injection) testable deterministically, without depending on
 * what a 2B model happens to say on the day.
 */
export const parseInto = (raw, schema) =>
  validateObject(extractObject(raw), schema);

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The router's schema is a single enum, so it does not need JSON at all.
 *
 * Asking a 2B model for `{"op":"set_text"}` spends tokens on syntax it can get wrong, for a
 * decision that is one word. Asking for the word directly is both cheaper and more reliable,
 * and it means the router costs one generation with an 8-token cap.
 */
const isRouteSchema = (schema) => {
  const properties = schema?.properties ?? {};
  const keys = Object.keys(properties);
  return (
    keys.length === 1 && keys[0] === "op" && Array.isArray(properties.op?.enum)
  );
};

/**
 * Pick the one allowed word the reply names, or nothing.
 *
 * Ambiguity resolves to nothing rather than to a guess: `plan.js` treats a missing op as
 * `answer`, which is its documented safe default and cannot damage the deck. Zero or two
 * matches therefore costs one generation, not a repair round.
 */
export const matchWord = (raw, allowed) => {
  // Strip punctuation but SPLIT ON WHITESPACE BEFORE NORMALISING. `normalise` maps spaces to
  // dashes so that `font_size` and `Font Size` both reach `font-size`, which is right for a
  // single value and wrong for a sentence: normalising first turns "The op is set_text." into
  // one token, `the-op-is-set-text`, that can never match anything.
  const cleaned = String(raw)
    .toLowerCase()
    .replace(/[.,!?;:'"`()[\]{}]+/g, " ")
    .trim();

  // A one-word reply, which is what we asked for.
  const exact = allowed.filter((op) => normalise(op) === normalise(cleaned));
  if (exact.length === 1) return exact[0];

  // Otherwise accept an op named as a whole word anywhere in the reply.
  const words = new Set(cleaned.split(/\s+/).filter(Boolean).map(normalise));
  const named = allowed.filter((op) => words.has(normalise(op)));
  if (named.length === 1) return named[0];

  return null;
};

const decodeRoute = async ({ system, message, schema, signal }) => {
  const allowed = schema.properties.op.enum;
  const raw = await guarded(
    generate({
      system: `${system}\n\nReply with EXACTLY ONE WORD from this list and nothing else:\n${allowed.join(", ")}`,
      message,
      maxOutputTokens: ROUTE_MAX_TOKENS,
      signal,
    }),
    "route",
    signal,
    ROUTE_TIMEOUT_MS,
  );

  const op = matchWord(raw, allowed);
  if (!op) {
    console.debug(
      `[chat] router said ${JSON.stringify(raw)}; defaulting to answer`,
    );
    return {};
  }
  return { op };
};

/* -------------------------------------------------------------------------- */
/* The public surface                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One schema-shaped object, or a throw.
 *
 * The signature is unchanged from the constrained-decoding version, so `plan.js` did not have
 * to change at all: `decode({ system, message, schema, label, signal })`.
 *
 * Note what is NOT here any more: the throwaway-session-per-call dance. That existed because
 * in Chrome 151 a second `responseConstraint` prompt on a session that had already served one
 * always rejected with `kErrorUnknown`, and `clone()` inherited the taint. `generate()` builds
 * and destroys its own conversation anyway, for a different reason -- keeping the router and
 * the fill pass out of the chat's history -- and the fill preface is rebuilt every turn from
 * the live inventory regardless, so there is nothing worth caching.
 */
export const decode = async ({
  system,
  message,
  schema,
  label = "planner",
  signal,
}) => {
  if (signal?.aborted) throw aborted();

  if (isRouteSchema(schema)) {
    return decodeRoute({ system, message, schema, signal });
  }

  const contract = contractFor(schema);
  const ask = (note) =>
    guarded(
      generate({
        system: [system, "", contract, note].filter(Boolean).join("\n"),
        message,
        maxOutputTokens: FILL_MAX_TOKENS,
        signal,
      }),
      label,
      signal,
      FILL_TIMEOUT_MS,
    );

  const first = parseInto(await ask(), schema);
  if (!first.problems.length) return first.value;

  // ONE repair, never two, and it names the specific failure -- "that was not valid JSON" is
  // not information a model can act on, whereas "prop was size, which is not in the list" is.
  // Each generation gets its own timeout; the caller's signal bounds the pair, which the
  // run-token stop in `use-conversation.js` makes safe.
  const second = parseInto(
    await ask(
      `Your previous reply was not usable: ${first.problems.join("; ")}. ` +
        "Reply again with only the corrected JSON object.",
    ),
    schema,
  );

  // Whatever validated is returned even if something is still missing, because `apply.js`
  // re-validates every op, supplies its own defaults for `scope` and `on`, and refuses
  // readably when an essential field is absent. Handing it a partial object gets a useful
  // message; throwing here would just lose the information.
  if (second.problems.length) {
    console.debug(
      `[chat] ${label} still imperfect: ${second.problems.join("; ")}`,
    );
  }
  if (!Object.keys(second.value ?? {}).length) {
    throw new Error(
      second.problems.join("; ") || "no usable fields in the reply",
    );
  }
  return second.value;
};
