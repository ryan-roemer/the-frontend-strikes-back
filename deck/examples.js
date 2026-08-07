/* global fetch:false */
/**
 * Get all examples as source.
 */

const EXAMPLES_PATHS = {
  task: {
    code: "./examples/TASK.md",
  },
  human: {
    code: "./examples/human/index.js",
  },
  copilot: {
    code: "./examples/copilot/index.js",
  },
  cursor: {
    code: "./examples/cursor/index.js",
  },
};

export const getExamples = async () => {
  const examples = {};

  for (const [key, { code }] of Object.entries(EXAMPLES_PATHS)) {
    examples[key] = {
      name: key,
      code: await fetch(code).then((res) => res.text()),
    };
  }

  return examples;
};
