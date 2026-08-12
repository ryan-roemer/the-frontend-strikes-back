/**
 * Just enough markdown for a chat bubble, with no dependencies.
 *
 * Both reference decks reach for `marked` + `dompurify` here, and both are
 * answering questions over long-form content. These answers are a few sentences
 * about a slide, so two more pinned CDN entries -- in a repo where the import map
 * IS the lockfile (see docs/dependencies.md) -- would buy inline links and
 * tables nobody is going to use, and bring a sanitizer along to guard against the
 * HTML they enable.
 *
 * Escaping FIRST and only then introducing a fixed set of tags means there is no
 * sanitizer to get right: nothing the model emits can become markup, because
 * every `<`, `&` and `"` is already an entity by the time any tag is added.
 *
 * Supported, because it is what an on-device model actually produces: `**bold**`,
 * `*italic*`, `` `code` ``, `- ` bullets, and blank-line paragraphs.
 */

const escapeHtml = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Inline marks, applied to already-escaped text.
 *
 * Code spans run first and their contents are parked in placeholders, so
 * asterisks inside `` `a * b` `` stay literal instead of turning into emphasis.
 *
 * The placeholder is `<n>`, and it is collision-proof for a specific reason:
 * `escapeHtml` has already turned every raw `<` in the input into `&lt;`, so an
 * angle bracket cannot appear in the text this function receives. A placeholder
 * built from ordinary characters -- `_0_`, ` 0 ` -- would eventually collide with
 * real content, and this answers questions about a deck that says things like
 * "slide 12 of 35". The `<br />` this function is handed for line breaks is not
 * digits, so it does not match either.
 */
const inline = (text) => {
  const codes = [];
  const withCode = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `<${codes.length - 1}>`;
  });

  const marked = withCode
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  return marked.replace(/<(\d+)>/g, (_, i) => `<code>${codes[i]}</code>`);
};

/** Markdown-ish text to an HTML string safe for `dangerouslySetInnerHTML`. */
export const renderMarkdown = (text) => {
  if (!text) return "";

  const blocks = escapeHtml(text)
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");

      // A block is a list only if every line is a bullet; a stray dash in prose
      // shouldn't turn a paragraph into a one-item list.
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        const items = lines
          .map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }

      return `<p>${inline(lines.join("<br />"))}</p>`;
    });

  return blocks.join("");
};
