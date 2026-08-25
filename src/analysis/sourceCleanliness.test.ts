import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import { probeVideo } from "@/video/ffmpeg";
import { scanSourceCleanliness, suggestCleanSourceQueries } from "./sourceCleanliness";

/**
 * Real ffmpeg + deterministic synthetic fixtures — matching this project's
 * convention (see CLAUDE.md) of exercising real ffmpeg rather than mocking
 * it. Frame content is generated pixel-by-pixel in Node with a seeded PRNG
 * (not an ffmpeg lavfi source like `testsrc`/`mandelbrot`/`gradients`) —
 * those all turned out to have their own static calibration regions or
 * non-reproducible-per-run content that produced flaky/misleading results
 * when tried here. This gives full, reproducible control: a "moving"
 * blocky-random background that genuinely changes every frame (so nothing
 * in it can look like a static overlay), with an optional striped box
 * stamped identically onto every frame (sharp edges throughout its area,
 * zero temporal variance) to simulate a burned-in caption/graphic overlay.
 */

const W = 320;
const H = 180;
const FRAME_COUNT = 24;
const FPS = 8;

function mulberry32(seed: number) {
  let s = seed;
  return function random(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blocky pseudo-random content that's completely different every frame — a stand-in for real, always-changing video footage. */
function backgroundFrame(frameIndex: number): Buffer {
  const rng = mulberry32(1000 + frameIndex * 97);
  const block = 8;
  const bw = Math.ceil(W / block);
  const bh = Math.ceil(H / block);
  const blocks = new Uint8Array(bw * bh);
  for (let i = 0; i < blocks.length; i++) blocks[i] = 40 + Math.floor(rng() * 160);
  const buf = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      buf[y * W + x] = blocks[Math.floor(y / block) * bw + Math.floor(x / block)];
    }
  }
  return buf;
}

/** Identical content on every frame, high-contrast stripes throughout — the dominant visual signature this module looks for (sharp AND temporally static). */
function stampStripedBox(frame: Buffer, x0: number, y0: number, w: number, h: number, stripe = 3): void {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const dark = Math.floor((x - x0) / stripe) % 2 === 0;
      frame[y * W + x] = dark ? 15 : 240;
    }
  }
}

async function buildVideo(destPath: string, overlays: { x: number; y: number; w: number; h: number }[]): Promise<void> {
  const frames: Buffer[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const frame = backgroundFrame(i);
    for (const o of overlays) stampStripedBox(frame, o.x, o.y, o.w, o.h);
    frames.push(frame);
  }
  const rawPath = `${destPath}.raw`;
  await writeFile(rawPath, Buffer.concat(frames));
  try {
    await run(env.ffmpegPath, [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${W}x${H}`,
      "-r",
      String(FPS),
      "-i",
      rawPath,
      "-pix_fmt",
      "yuv420p",
      destPath,
    ]);
  } finally {
    await rm(rawPath, { force: true });
  }
}

test("scanSourceCleanliness: clean footage (always-changing background, no overlays) passes with a high score", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cleanliness-clean-"));
  try {
    const videoPath = path.join(dir, "clean.mp4");
    await buildVideo(videoPath, []);
    const result = await scanSourceCleanliness(videoPath, dir, await probeVideo(videoPath));

    assert.equal(result.hasLargeCaptions, false, result.reason);
    assert.equal(result.hasLargeGraphicOverlays, false, result.reason);
    assert.equal(result.hasSplitScreen, false, result.reason);
    assert.equal(result.likelyRepost, false, result.reason);
    assert.ok(result.score >= 75, `expected a clean score >= 75, got ${result.score} (${result.reason})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanSourceCleanliness: regression — captions + arrow/circle-like overlay on a heavily edited Short is rejected before Anthropic", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cleanliness-dirty-"));
  try {
    const videoPath = path.join(dir, "dirty.mp4");
    // A wide, static, high-contrast band in the lower third (caption-like)
    // plus a compact static box away from the caption zone and corners
    // (arrow/circle/graphic-annotation-like) — the exact pattern the
    // production incident this PR fixes was built from: a genuinely good
    // Road Rage / Instant Karma incident buried in a heavily edited Short.
    await buildVideo(videoPath, [
      { x: 27, y: 133, w: 267, h: 37 },
      { x: 120, y: 20, w: 80, h: 80 },
    ]);
    const result = await scanSourceCleanliness(videoPath, dir, await probeVideo(videoPath));

    assert.equal(result.hasLargeCaptions, true, result.reason);
    assert.equal(result.hasArrows, true, result.reason);
    assert.equal(result.hasCircles, true, result.reason);
    assert.equal(result.hasLargeGraphicOverlays, true, result.reason);
    assert.equal(result.likelyRepost, true, result.reason);
    assert.ok(result.score < 75, `expected a dirty score < 75, got ${result.score} (${result.reason})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanSourceCleanliness: a small corner watermark alone is treated as acceptable (score stays high)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cleanliness-corner-"));
  try {
    const videoPath = path.join(dir, "corner.mp4");
    // A tiny static box in the extreme top-left corner only — the "small
    // dashcam timestamp / corner watermark" case the spec says is fine.
    await buildVideo(videoPath, [{ x: 3, y: 3, w: 21, h: 13 }]);
    const result = await scanSourceCleanliness(videoPath, dir, await probeVideo(videoPath));

    assert.equal(result.hasLargeCaptions, false, result.reason);
    assert.equal(result.hasLargeGraphicOverlays, false, result.reason);
    assert.ok(result.score >= 75, `expected corner watermark to stay clean, got ${result.score} (${result.reason})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("suggestCleanSourceQueries: strips #shorts/tiktok noise and appends clean-source search variants", () => {
  const queries = suggestCleanSourceQueries("Road Rage Brake Check Gets Instant Karma #shorts");
  assert.ok(queries.length > 0);
  for (const q of queries) {
    assert.doesNotMatch(q.toLowerCase(), /#shorts|shorts\b/);
  }
  assert.ok(queries.some((q) => q.includes("original")));
  assert.ok(queries.every((q) => q.startsWith("Road Rage Brake Check Gets Instant Karma")));
});

test("suggestCleanSourceQueries: empty/whitespace-only title after stripping returns no queries", () => {
  assert.deepEqual(suggestCleanSourceQueries("#shorts #tiktok"), []);
});

test("sourceCleanliness.ts never imports the Anthropic/AI layer — the cleanliness gate is zero-Anthropic", async () => {
  const src = await readFile(new URL("./sourceCleanliness.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']@\/ai\//);
});
