/**
 * Get all examples as source.
 *
 * Code samples live as real, lintable files in `examples/` and are fetched at
 * runtime so the deck stays build-free while the snippets stay honest.
 */

// `language` is the Prism grammar for the code pane; it defaults to JavaScript,
// so only the non-JS examples name one.
const EXAMPLES_PATHS = {
  registerTool: { code: "./examples/register-tool.js" },
  declarativeTool: {
    code: "./examples/declarative-tool.html",
    language: "html",
  },
  toolHandler: { code: "./examples/tool-handler.js" },
};

const getExample = async (name, path, language) => {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Example "${name}" failed: ${path} (${res.status})`);
  }

  // `file` is shown on the code pane's filename bar, so the audience can see
  // the snippet is a real file in the repo rather than slide-only code.
  return {
    name,
    file: path.split("/").pop(),
    code: (await res.text()).trim(),
    language,
  };
};

export const getExamples = async () => {
  const examples = await Promise.all(
    Object.entries(EXAMPLES_PATHS).map(([name, { code, language }]) =>
      getExample(name, code, language),
    ),
  );

  return Object.fromEntries(examples.map((example) => [example.name, example]));
};
