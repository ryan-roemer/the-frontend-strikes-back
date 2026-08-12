import { roleOf, slideNodes, slideRoot } from "../deck-adapter.js";

/**
 * A durable address for one element.
 *
 * `data-chat-ref` is fine WITHIN a turn but cannot be the address a patch stores:
 * React drops an attribute it does not own when the node is recreated, and
 * presenter / overview / print mode remount the entire view subtree. A patch has
 * to outlive that, because the patch log is what re-applies edits afterwards.
 *
 * So: a structural path from the slide root, verified by role and a text snippet,
 * with a role+snippet search as the fallback. Two layers is the right amount --
 * the path is exact when the structure is unchanged, the snippet catches the case
 * where it moved. A third layer (XPath, content hashing) buys nothing on a deck
 * whose structure is static between remounts.
 */

/** Child-index path from the slide root down to `el`. */
const pathTo = (el, root) => {
  const path = [];
  for (let node = el; node && node !== root; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) return null; // Detached: not addressable.
    path.unshift([...parent.children].indexOf(node));
  }
  return path;
};

const snippetOf = (el) =>
  el.textContent.replace(/\s+/g, " ").trim().slice(0, 40);

export const locatorFor = (el, slideIndex) => {
  const root = slideRoot(slideNodes()[slideIndex]);
  if (!root) return null;
  const path = pathTo(el, root);
  if (!path) return null;
  return { slideIndex, path, role: roleOf(el), snippet: snippetOf(el) };
};

/** Stable string form, for keying baselines. */
export const keyOf = (locator) =>
  `${locator.slideIndex}:${locator.path.join(".")}`;

const looksRight = (el, locator) =>
  !!el &&
  (roleOf(el) === locator.role ||
    snippetOf(el) === locator.snippet ||
    el.textContent.includes(locator.snippet.slice(0, 20)));

/**
 * Find the element a locator names, or null.
 *
 * Path first, then a role+snippet sweep. The sweep is deliberately narrow: it
 * matches on the recorded role AND a prefix of the recorded text, so it will fail
 * rather than confidently patch the wrong heading.
 */
export const resolve = (locator) => {
  const root = slideRoot(slideNodes()[locator.slideIndex]);
  if (!root) return null;

  let node = root;
  for (const index of locator.path) {
    node = node?.children?.[index];
    if (!node) break;
  }
  if (looksRight(node, locator)) return node;

  const prefix = locator.snippet.slice(0, 20);
  for (const candidate of root.querySelectorAll("*")) {
    if (
      roleOf(candidate) === locator.role &&
      candidate.textContent.includes(prefix)
    ) {
      return candidate;
    }
  }
  return null;
};
