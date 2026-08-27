import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import { probeVideo } from "@/video/ffmpeg";
import { updateSettings } from "@/database/settings";
import { prisma } from "@/database/client";
import { AiBudgetBlockedError } from "@/ai/budget";
import { runQuickScan, quickScanFrameCount } from "./quickScan";

/**
 * Proves the hard AI-spend gate (src/ai/budget.ts) is actually reached by
 * the real quick-scan call path — not just unit-tested in isolation. Uses
 * a real, tiny, local synthetic video (no yt-dlp/network needed, since
 * runQuickScan takes a file path directly) so this exercises real ffmpeg
 * frame extraction feeding into the real `analyzeFrames` -> `reserveAiBudget`
 * gate. Only ever exercises the BLOCKED paths here: the reservation check
 * runs and blocks before the Anthropic client is ever constructed, so no
 * network call or API key is required — this must never reach the real
 * Anthropic API in a test.
 */
async function makeTinyVideo(dir: string): Promise<string> {
  const videoPath = path.join(dir, "tiny.mp4");
  await run(env.ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=64x64:rate=4:duration=2",
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  return videoPath;
}

test("quickScanFrameCount: always bounded to [6, 12] regardless of source duration — never blindly proportional to length", () => {
  assert.equal(quickScanFrameCount(0), 6, "degenerate/zero duration still gets the minimum");
  assert.equal(quickScanFrameCount(30), 6, "a very short source clamps up to the minimum, not down to ~2");
  assert.equal(quickScanFrameCount(120), 6, "120s / 20s-target = 6, right at the minimum");
  assert.equal(quickScanFrameCount(180), 9, "180s / 20s-target = 9, within range");
  assert.equal(quickScanFrameCount(240), 12, "240s / 20s-target = 12, right at the maximum");
  assert.equal(quickScanFrameCount(3600), 12, "a full hour-long source still clamps down to the maximum, not up to 180");
});

test("runQuickScan: Paid AI Analysis OFF -> AiBudgetBlockedError, zero ApiUsage rows written", async () => {
  // Deliberately doesn't touch env.anthropicApiKey (unlike src/ai/budget.test.ts)
  // — node's test runner can run multiple test files' top-level code
  // concurrently, so mutating that shared singleton here raced with
  // budget.test.ts's own mutations of the same global. paid_ai_disabled is
  // checked before the API-key check anyway, so this test doesn't need to
  // touch it at all.
  await updateSettings({ paidAiAnalysisEnabled: false });
  const dir = await mkdtemp(path.join(tmpdir(), "quickscan-blocked-"));
  const runToken = randomUUID();
  try {
    const videoPath = await makeTinyVideo(dir);
    const info = await probeVideo(videoPath);

    await assert.rejects(
      runQuickScan(videoPath, dir, info, "road_rage", { runToken, sourceVideoId: "test-video" }),
      (err: unknown) => {
        assert.ok(err instanceof AiBudgetBlockedError);
        assert.equal(err.reason, "paid_ai_disabled");
        return true;
      },
    );

    const usageCount = await prisma.apiUsage.count({ where: { runToken } });
    assert.equal(usageCount, 0, "a blocked call must never write an ApiUsage row");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await prisma.apiUsage.deleteMany({ where: { runToken } });
  }
});

test("runQuickScan: missing ANTHROPIC_API_KEY (Paid AI ON) -> AiBudgetBlockedError with reason no_api_key — this is what turns a missing key into WAITING_FOR_AI instead of a repeated failure loop", async () => {
  // Relies on this environment genuinely having no ANTHROPIC_API_KEY set
  // (true for this sandbox and should be true for any CI environment — a
  // real paid key must never be configured for tests) rather than
  // mutating the shared env singleton, for the same cross-file-race reason
  // as the test above.
  assert.equal(env.anthropicApiKey, undefined, "this test assumes no real Anthropic key is configured in this environment");
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100 });
  const dir = await mkdtemp(path.join(tmpdir(), "quickscan-nokey-"));
  const runToken = randomUUID();
  try {
    const videoPath = await makeTinyVideo(dir);
    const info = await probeVideo(videoPath);

    await assert.rejects(
      runQuickScan(videoPath, dir, info, "road_rage", { runToken, sourceVideoId: "test-video" }),
      (err: unknown) => {
        assert.ok(err instanceof AiBudgetBlockedError);
        assert.equal(err.reason, "no_api_key");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await prisma.apiUsage.deleteMany({ where: { runToken } });
  }
});
