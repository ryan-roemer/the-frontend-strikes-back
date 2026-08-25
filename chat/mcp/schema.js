/**
 * Reading a tool's `inputSchema`, for the two things that have to render one.
 *
 * The inspector builds a form from it (`chat/tools/form.js`) and the in-page model is
 * given a compact signature built from it (`chat/agent/act/catalog.js`). Those are the
 * same question -- what arguments does this tool take, which are required, which are
 * closed sets -- asked by a human-facing widget and a model-facing string.
 *
 * HERE RATHER THAN IN `form.js`, WHERE BOTH STARTED. `form.js` is behind the inspector's
 * `lazy()` boundary, which exists so that `modal.js` and everything it pulls in stay off
 * the initial load (`chat/tools/gate.js`). Importing two pure helpers out of it from the
 * catalog would have dragged the form into every page load to read a schema, quietly
 * undoing that. These have no React in them and no business being behind a modal.
 *
 * `chat/mcp/` is the right home because a tool schema is an MCP concept, and this sits
 * beside `shape.js`, which does the same job for the other end of a call.
 */

/**
 * The first sentence, plus a trailing parenthetical if there is one.
 *
 * Descriptions in `tools.js` are written for a model and run long -- `find_nodes` opens
 * with three sentences, `style_node` lists twelve CSS properties. Both consumers want the
 * short form: the inspector for a placeholder inside a field, where anything past a line
 * is noise, and the catalog because the full text of eight descriptions is ~1,400 tokens
 * re-prefilled on every turn.
 */
export const summarize = (text) => {
  if (!text) return "";
  const parenthetical = text.match(/\s+(\([^)]+\))\s*$/);
  const body = parenthetical ? text.slice(0, parenthetical.index) : text;

  // A full stop only ENDS A SENTENCE when a new one starts after it. Splitting
  // on the first `.` instead turns "A node id like '9.3'" into "A node id like
  // '9." and "The value, e.g. 'red'" into "The value, e." -- both of which are
  // in this deck's schemas, and both of which read as a truncation bug rather
  // than as a summary. Requiring whitespace and then a capital or a bracket
  // costs one lookahead and gets decimals, ids and `e.g.` right.
  const first = body.match(/^.*?[.!?](?=\s+[A-Z(]|\s*$)/s);
  const head = (first ? first[0] : body).trim();
  return parenthetical ? `${head} ${parenthetical[1]}` : head;
};

/**
 * Schema properties, flattened into what a widget needs.
 *
 * `kind` collapses JSON Schema's type vocabulary onto the four controls that
 * exist. `enum` is checked BEFORE `type`, because a string with an enum is a
 * dropdown and a string without one is a text box, and that distinction matters
 * more here than the type does -- several of this deck's parameters are enums, drawn
 * straight from `chat/edit/apply.js`, and typing `background-color` by hand at a podium is
 * how you find out you typed `background_color`.
 *
 * `options` is what the catalog reads too, for the opposite reason: an enum is the
 * cheapest constraint available on a runtime with no grammar-constrained decoding, so it
 * is the one part of a schema the model gets in full rather than summarised.
 */
export const fieldsOf = (schema) => {
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    required: required.includes(name),
    description: prop.description ?? "",
    type: prop.type ?? "any",
    options: prop.enum ?? null,
    kind: prop.enum
      ? "enum"
      : prop.type === "boolean"
        ? "boolean"
        : prop.type === "number" || prop.type === "integer"
          ? "number"
          : "text",
  }));
};
