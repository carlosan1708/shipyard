import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}

try {
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("FFmpeg is required for GIF export. Install it and make sure ffmpeg is on PATH.");
  }
  const artifacts = join(root, ".shipyard", "playwright");
  mkdirSync(artifacts, { recursive: true });
  const recording = mkdtempSync(join(artifacts, "record-"));
  const cli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
  run(process.execPath, [cli, "test", "shipyard-demo.spec.ts", "--output", recording], {
    ...process.env,
    SHIPYARD_RECORD_DEMO: "1",
  });

  const videos = readdirSync(recording, { recursive: true }).filter((file) => file.endsWith(".webm"));
  if (videos.length !== 1) throw new Error(`Expected one Playwright video, found ${videos.length} in ${recording}`);
  const video = join(recording, videos[0]);
  const images = join(root, "docs", "images");
  mkdirSync(images, { recursive: true });
  const exportDir = mkdtempSync(join(images, ".record-"));
  const gif = join(images, "shipyard-demo.gif");
  try {
    const draft = join(exportDir, "shipyard-demo.gif");
    // Keep the UI readable while encoding similar frames as longer holds instead of repeated images.
    const gifFilter = [
      "fps=8,scale=1200:-1:flags=lanczos,mpdecimate=hi=384:lo=160:frac=0.12,split[frames][colors]",
      "[colors]palettegen=max_colors=128:stats_mode=diff[palette]",
      "[frames][palette]paletteuse=dither=none:diff_mode=rectangle",
    ].join(";");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", video,
      "-filter_complex", gifFilter, "-fps_mode", "vfr", "-final_delay", "270", "-loop", "0", draft,
    ]);
    renameSync(draft, gif);
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
  console.log(`Video: ${relative(root, video)}\nGIF:   ${relative(root, gif)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
