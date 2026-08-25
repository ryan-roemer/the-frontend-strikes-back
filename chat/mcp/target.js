/**
 * "9.3" or "the second bullet" -- one contract, every tool that names a node.
 *
 * Two ways to point at something, and both are worth having:
 *
 *   an ID     exact, and what a tool returns so the next call can be precise
 *   a PHRASE  what a person says, and what an agent produces on its first try
 *
 * Accepting both is what lets "change the second bullet to X" be ONE call when
 * the phrase is unambiguous, while still leaving a precise second call available
 * when it is not. Splitting them into separate tools would force every agent
 * through find-then-act even for the easy case.
 *
 * AMBIGUITY IS A REFUSAL, NEVER A PICK. `locate()` returns candidates rather
 * than choosing, and this preserves that all the way out to the tool result:
 * slide 31 says "TODO" several times over, so the case is real, and picking the first
 * is the one outcome nothing downstream can recover from. The refusal carries
 * the candidates with their echo-back descriptions, so the agent's next call
 * costs one round trip and cannot miss.
 */
import { resolveNode } from "../harvest/index.js";
import { locate } from "../harvest/locate.js";
import { describeNode, position } from "../harvest/views.js";
import { line, nodeData } from "./shape.js";

/** `9.3` -- a slide number, a dot, an ordinal. Anything else is a phrase. */
const ID = /^\d{1,2}\.\d{1,3}$/;

/**
 * An MCP error result, with the candidates when there are any.
 *
 * CANDIDATES GO IN `structuredContent` TOO. They are the entire reason for
 * refusing rather than guessing, so a caller that has to recover them by parsing
 * `"6.9 — takeaway: ..."` out of prose is back to a brittle regex at exactly the
 * moment precision matters. The prose stays for whatever reads content blocks.
 */
const refuse = (message, nodes = []) => ({
  ok: false,
  result: {
    isError: true,
    content: [{ type: "text", text: [message, ...nodes.map(line)].join("\n") }],
    structuredContent: { candidates: nodes.map(nodeData) },
  },
});

/**
 * A target -> the node it names.
 *
 * Returns `{ ok: true, node }` or `{ ok: false, result }`, where `result` is a
 * finished MCP error the caller can return unchanged. Callers stay linear:
 *
 *   const found = resolveTarget(args.target);
 *   if (!found.ok) return found.result;
 *
 * `slide` scopes a phrase to one slide; without it a phrase resolves against
 * whatever is on screen, which is what "the second bullet" means to someone
 * looking at the deck.
 */
export const resolveTarget = (target, { slide } = {}) => {
  const said = String(target ?? "").trim();
  if (!said) return refuse("Name a node, by id (like 9.3) or by description.");

  if (ID.test(said)) {
    const node = resolveNode(said);
    return node
      ? { ok: true, node }
      : refuse(
          `No node ${said}. Slide ${said.split(".")[0]} may not have that many, or the deck moved.`,
        );
  }

  const found = locate(said, { slide });

  if (found.match === "ambiguous") {
    return refuse(
      `"${said}" matches ${found.nodes.length} nodes. Call again with one of these ids:`,
      found.nodes,
    );
  }

  if (found.match === "none") {
    const where = slide ?? position().slide;
    // THE NOTE IS A WHOLE SENTENCE, not a clause to splice in: interpolating it into
    // "... on slide ${where}" turns the note "no slide" into `"phrase" — no slide on
    // slide 0.`, two failure modes glued into one ungrammatical claim.
    return refuse(
      found.note
        ? `"${said}" — ${found.note}.`
        : `Nothing on slide ${where} matches "${said}". What is there:`,
      // The roster IS the useful answer to a miss: it turns "no" into a menu.
      found.nodes.slice(0, 12),
    );
  }

  return { ok: true, node: found.nodes[0] };
};

/**
 * The line a receipt leads with.
 *
 * Always the echo-back, because the whole point of resolving a phrase is that
 * the caller can see WHICH node it landed on. A receipt that only says "done"
 * hides the one thing worth checking.
 */
export const echo = (id) => describeNode(id) ?? id;

/**
 * The note `locate()` attaches when a phrase named a ROLE and nothing narrowed it.
 *
 * Matched rather than re-derived, because `locate()` is the only thing that knows
 * which tier answered, and re-deriving it here from the nodes would be a second
 * implementation of the same judgement that could disagree with the first.
 */
const ROLE_AMBIGUITY = "role matched, no position";

/**
 * A target -> the nodes it names, where NAMING SEVERAL CAN BE THE ANSWER.
 *
 * `resolveTarget` refuses every ambiguity, and for a tool that rewrites wording it is
 * right to: "change the TODO" with three TODOs on the slide has no safe reading, and
 * picking one is unrecoverable.
 *
 * BUT NOT EVERY AMBIGUITY IS A COIN FLIP. "Make this list yellow" names a group, and
 * `locate()` already distinguishes the two cases -- it returns `ambiguous` with the note
 * `"role matched, no position"` when a phrase named a role the slide has several of, and
 * `"text matched"` when several nodes happened to contain the same words. The first is
 * a set the user meant; the second is a question they have not answered yet.
 *
 * So this accepts the role case and still refuses the text case, which keeps the
 * distinction `locate.js` was careful to draw instead of flattening it. Styling is the
 * only caller, and deliberately: a style is uniform across a group and undoes in one
 * call, so being wrong about the extent costs a keystroke. Rewriting is not, which is
 * why `edit_text` keeps going through `resolveTarget`.
 *
 * Returns `{ ok: true, nodes }` or `{ ok: false, result }`, matching `resolveTarget` so
 * callers stay linear.
 */
export const resolveGroup = (target, { slide } = {}) => {
  const said = String(target ?? "").trim();

  // An id names one node, and so does anything `resolveTarget` resolves cleanly. Only
  // the ambiguous branch needs different treatment, so everything else goes through the
  // existing contract rather than around it -- one code path for ids, misses, and
  // out-of-range slides, with their messages unchanged.
  if (ID.test(said) || !said) {
    const found = resolveTarget(said, { slide });
    return found.ok ? { ok: true, nodes: [found.node] } : found;
  }

  const found = locate(said, { slide });
  if (found.match === "ambiguous" && found.note === ROLE_AMBIGUITY) {
    return { ok: true, nodes: found.nodes };
  }

  const single = resolveTarget(said, { slide });
  return single.ok ? { ok: true, nodes: [single.node] } : single;
};
