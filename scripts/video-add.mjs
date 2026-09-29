// Encodes a screen recording into a demo's backup video, plus a poster.
//
//   npm run video:add -- ~/Desktop/rec.mov <demo-id>
//
// Writes `media/videos/<demo-id>.mp4` and `.jpg` (gitignored), replacing any earlier
// ones. The demo id must be listed in `deck/demos.js`. See docs/offline.md.
//
// MACOS TOOLS ONLY, no ffmpeg:
//
//   avconvert -p Preset1920x1080   H.264, scaled down to fit 1920x1080 (never up), with
//                                  the `moov` index before the data ("fast start"), so
//                                  playback starts before the whole file has loaded.
//                                  A HiDPI recording of a 16:10 screen comes out
//                                  1728x1080, which keeps small text readable.
//   qlmanage -t                    a Quick Look thumbnail of the video, for the poster
//   sips                           PNG to JPEG
//
// The presets have no quality or bitrate setting, and they keep an audio track if the
// source has one. So the script reads the result back and checks it: H.264, fast
// start, and no audio (a warning, since `<video>` plays muted anyway). It prints the
// size and MB per minute, so an oversized encode is visible.
//
// avconvert and qlmanage go through macOS services that Claude Code's sandbox blocks
// ("you don't have permission"). Run this from a normal terminal.

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_VIDEOS, posterPath, videoPath } from "../deck/demos.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs a tool. `quiet` drops its stdout (qlmanage and sips narrate every file). */
const run = (cmd, args, { quiet = false } = {}) => {
  const stdout = quiet ? "ignore" : "inherit";
  const result = spawnSync(cmd, args, { stdio: ["ignore", stdout, "inherit"] });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}`);
};

// Boxes that hold other boxes, down to where the codec and track type live.
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/**
 * What's inside an MP4: the order of the top-level boxes, and each track's handler
 * (`vide`, `soun`), codec and size. Reads only box headers and the few fields needed.
 */
const inspect = (buf) => {
  const info = { top: [], tracks: [], seconds: 0 };
  let track = null;

  const walk = (start, end, depth) => {
    for (let pos = start; pos + 8 <= end;) {
      let size = buf.readUInt32BE(pos);
      const type = buf.toString("latin1", pos + 4, pos + 8);
      let body = pos + 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(pos + 8));
        body = pos + 16;
      } else if (size === 0) size = end - pos;
      if (size < 8) break;

      if (depth === 0) info.top.push(type);
      if (type === "trak") info.tracks.push((track = {}));
      if (type === "mvhd") {
        const v1 = buf[body] === 1;
        const scale = buf.readUInt32BE(body + (v1 ? 20 : 12));
        const duration = v1
          ? Number(buf.readBigUInt64BE(body + 24))
          : buf.readUInt32BE(body + 16);
        info.seconds = duration / scale;
      }
      if (type === "hdlr" && track)
        track.handler = buf.toString("latin1", body + 8, body + 12);
      if (type === "stsd" && track) {
        // Version and flags, entry count, then the first sample entry.
        const entry = body + 8;
        track.codec = buf.toString("latin1", entry + 4, entry + 8);
        if (track.handler === "vide") {
          track.width = buf.readUInt16BE(entry + 32);
          track.height = buf.readUInt16BE(entry + 34);
        }
      }
      if (CONTAINERS.has(type)) walk(body, pos + size, depth + 1);
      pos += size;
    }
  };

  walk(0, buf.length, 0);
  return info;
};

const main = async () => {
  const [source, id] = process.argv.slice(2);
  const ids = Object.keys(DEMO_VIDEOS);
  if (!source || !id) {
    throw new Error(
      `usage: npm run video:add -- <file.mov> <demo-id>\n  demo ids: ${ids.join(", ")}`,
    );
  }
  if (!ids.includes(id)) {
    throw new Error(
      `unknown demo id "${id}". Add it to deck/demos.js and to its DemoSlide first.\n  demo ids: ${ids.join(", ")}`,
    );
  }
  const input = resolve(source);
  await stat(input);

  const out = resolve(ROOT, videoPath(id));
  const poster = resolve(ROOT, posterPath(id));
  await mkdir(dirname(out), { recursive: true });

  const scratch = await mkdtemp(join(tmpdir(), "video-add-"));
  try {
    const mp4 = join(scratch, `${id}.mp4`);
    console.log(`encoding ${basename(input)} ...`);
    run("avconvert", [
      "--preset",
      "Preset1920x1080",
      "--source",
      input,
      "--output",
      mp4,
      "--replace",
      "--progress",
    ]);

    const info = inspect(await readFile(mp4));
    const video = info.tracks.find((t) => t.handler === "vide");
    const audio = info.tracks.filter((t) => t.handler === "soun");
    if (video?.codec !== "avc1") {
      throw new Error(
        `expected an H.264 (avc1) video track, got ${video?.codec ?? "none"}`,
      );
    }
    if (info.top.indexOf("moov") > info.top.indexOf("mdat")) {
      throw new Error("the index (moov) comes after the data: not fast start");
    }

    const png = join(scratch, `${id}.mp4.png`);
    run("qlmanage", ["-t", "-s", "1920", "-o", scratch, mp4], { quiet: true });
    run(
      "sips",
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "80",
        png,
        "--out",
        join(scratch, `${id}.jpg`),
      ],
      { quiet: true },
    );

    await copyFile(mp4, out);
    await copyFile(join(scratch, `${id}.jpg`), poster);

    const { size } = await stat(out);
    const mb = size / 1024 / 1024;
    const minutes = info.seconds / 60;
    console.log(`\n${videoPath(id)}`);
    console.log(
      `  ${video.width}x${video.height} H.264, ${info.seconds.toFixed(1)} s, ${mb.toFixed(1)} MB (${(mb / minutes).toFixed(1)} MB/min), fast start`,
    );
    if (audio.length) {
      console.log(
        "  WARNING: has an audio track. It plays muted, but the file is bigger than it needs to be.",
      );
    }
    console.log(`${posterPath(id)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

main().catch((err) => {
  console.error(`video:add: ${err.message}`);
  process.exitCode = 1;
});
