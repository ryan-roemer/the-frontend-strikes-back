/**
 * How a node leaves this layer, in both of the shapes a tool result carries.
 *
 * Every result has two readers with opposite needs -- a model reading the text block, and
 * whatever chains one call into the next reading `structuredContent` -- so every node is
 * written twice. Both writings lived in two places: `tools.js` had `line` and `nodeData`,
 * and `target.js`'s `refuse()` had byte-identical copies of each inlined. They cannot
 * simply import from `tools.js`, because `tools.js` imports `target.js`.
 *
 * KEEPING THEM TOGETHER IS THE POINT. The prose and the data describe the same node, and
 * a caller that finds an id in one and not the other has no way to tell which is right.
 */

/** One node as a line of prose. The id leads, because it is what the next call needs. */
export const line = (node) => `${node.id} — ${node.role}: ${node.text}`;

/**
 * One node as data.
 *
 * EXPLICIT FIELDS, not a spread. A harvested node carries a non-enumerable `fiber` and a
 * live `el`; both are omitted here by construction rather than by remembering to delete
 * them, and a DOM node in a `structuredContent` payload makes `JSON.stringify` throw at
 * exactly the moment somebody is trying to read a result.
 */
export const nodeData = (node) => ({
  id: node.id,
  slide: node.slide,
  ordinal: node.ordinal,
  role: node.role,
  roleOrdinal: node.roleOrdinal,
  depth: node.depth,
  text: node.text,
});
