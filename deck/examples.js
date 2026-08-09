/* global fetch:false */
/**
 * Get all examples as source.
 *
 * Code samples live as real, lintable files in `examples/` and are fetched at
 * runtime so the deck stays build-free while the snippets stay honest.
 */

const EXAMPLES_PATHS = {
  registerTool: { code: "./examples/register-tool.js" },
  toolSchema: { code: "./examples/tool-schema.js" },
  toolHandler: { code: "./examples/tool-handler.js" },
};

const getExample = async (name, path) => {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Example "${name}" failed: ${path} (${res.status})`);
  }

  // `file` is shown on the code pane's filename bar, so the audience can see
  // the snippet is a real file in the repo rather than slide-only code.
  return { name, file: path.split("/").pop(), code: await res.text() };
};

export const getExamples = async () => {
  const examples = await Promise.all(
    Object.entries(EXAMPLES_PATHS).map(([name, { code }]) =>
      getExample(name, code),
    ),
  );

  return Object.fromEntries(examples.map((example) => [example.name, example]));
};
