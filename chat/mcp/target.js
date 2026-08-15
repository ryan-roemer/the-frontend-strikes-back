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
 * slide 31 says "TODO" three times, so the case is real, and picking the first
 * is the one outcome nothing downstream can recover from. The refusal carries
 * the candidates with their echo-back descriptions, so the agent's next call
 * costs one round trip and cannot miss.
 */
import { resolveNode } from "../harvest/index.js";
import { locate } from "../harvest/locate.js";
import { describeNode, position } from "../harvest/views.js";

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
const refuse = (text, nodes = []) => ({
  ok: false,
  result: {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          text,
          ...nodes.map((n) => `${n.id} — ${n.role}: ${n.text}`),
        ].join("\n"),
      },
    ],
    structuredContent: {
      candidates: nodes.map(
        ({ id, slide, ordinal, role, roleOrdinal, depth, text: value }) => ({
          id,
          slide,
          ordinal,
          role,
          roleOrdinal,
          depth,
          text: value,
        }),
      ),
    },
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
    // THE NOTE IS A WHOLE SENTENCE, not a clause to splice in. It used to be
    // interpolated into "... on slide ${where}", which turned the note "no
    // slide" into `"phrase" — no slide on slide 0.` -- two failure modes glued
    // into one ungrammatical claim. Notes now stand alone and the slide is named
    // only where there is a slide to name.
    return refuse(
      found.note
        ? `"${said}" — ${found.note}.`
        : `Nothing on slide ${where} matches "${said}". What is there:`,
      // The roster IS the useful answer to a miss: it turns "no" into a menu.
      found.nodes.slice(0, 12),
    );
  }

  return { ok: true, node: found.nodes[0], via: found.match };
};

/**
 * The line a receipt leads with.
 *
 * Always the echo-back, because the whole point of resolving a phrase is that
 * the caller can see WHICH node it landed on. A receipt that only says "done"
 * hides the one thing worth checking.
 */
export const echo = (id) => describeNode(id) ?? id;
