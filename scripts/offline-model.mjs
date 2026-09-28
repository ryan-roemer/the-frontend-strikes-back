// Downloads the Gemma model to `offline/models/`, for `sw.js` to serve in place of
// HuggingFace on `?offline` pages.
//
//   npm run offline:model
//
// RESUMABLE. `curl -C -` carries on from wherever the last run stopped, so a dropped
// connection costs a re-run, not a fresh 2 GB. A file that is already the right size
// is left alone.
//
// CHECKED AGAINST `EXPECTED_BYTES`, read from `chat/agent/providers/litert.js` along with
// the repo and file name, so the deck and this script can't disagree about which model
// it is. Only a complete file is listed in `offline/models.json`; `sw.js` serves nothing
// else, so a partial download means "fetch from HuggingFace as usual".
//
// Layout (gitignored):
//
//   offline/models.json          { url: { file, type, bytes } }, the same shape as
//                                `manifest.json`, which `offline:fetch` rewrites
//   offline/models/<file>        the model itself

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "offline");
const MODELS = resolve(OUT, "models");
const INDEX = resolve(OUT, "models.json");
const PROVIDER = resolve(ROOT, "chat", "agent", "providers", "litert.js");

/** The model's repo, file and size, as `litert.js` declares them. */
const readModel = async () => {
  const source = await readFile(PROVIDER, "utf8");
  const repo = source.match(/repo:\s*"([^"]+)"/)?.[1];
  const file = source.match(/file:\s*"([^"]+)"/)?.[1];
  const bytes = Number(source.match(/EXPECTED_BYTES\s*=\s*(\d+)/)?.[1]);
  if (!repo || !file || !bytes) {
    throw new Error(
      `couldn't find the model's repo, file or size in ${PROVIDER}`,
    );
  }
  return {
    url: `https://huggingface.co/${repo}/resolve/main/${file}`,
    file,
    bytes,
  };
};

const sizeOf = (path) =>
  stat(path).then(
    (s) => s.size,
    () => 0,
  );

const curl = (args) =>
  new Promise((done, fail) => {
    const child = spawn("curl", args, { stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => done(code));
  });

const main = async () => {
  const model = await readModel();
  const path = resolve(MODELS, model.file);
  await mkdir(MODELS, { recursive: true });

  let size = await sizeOf(path);
  // Bigger than expected can't be resumed into shape. Start again.
  if (size > model.bytes) {
    console.log(`${model.file} is larger than expected; downloading it again`);
    await rm(path);
    size = 0;
  }

  if (size === model.bytes) {
    console.log(`${model.file} is already complete (${model.bytes} bytes)`);
  } else {
    if (size)
      console.log(`resuming ${model.file} at ${size} of ${model.bytes} bytes`);
    // `-L` because HuggingFace redirects to its CDN. `--retry` resumes too, with `-C -`.
    const code = await curl([
      "-L",
      "--fail",
      "--retry",
      "5",
      "--retry-delay",
      "2",
      "-C",
      "-",
      "-o",
      path,
      model.url,
    ]);
    size = await sizeOf(path);
    if (code !== 0) console.error(`curl exited with ${code}`);
  }

  if (size !== model.bytes) {
    await rm(INDEX, { force: true });
    throw new Error(
      `${model.file} is ${size} of ${model.bytes} bytes. Run it again to resume.`,
    );
  }

  const index = {
    [model.url]: {
      file: `models/${model.file}`,
      type: "application/octet-stream",
      bytes: model.bytes,
    },
  };
  await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`saved ${path}\nlisted in ${INDEX}`);
};

main().catch((err) => {
  console.error(`offline:model: ${err.message}`);
  process.exitCode = 1;
});
