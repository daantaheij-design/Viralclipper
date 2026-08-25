import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/database/client";
import { storage, storageKeyFor } from "@/storage";
import { repairRender } from "./rerender";

async function makeMoment(tikTokStatus: "ready" | "media_missing" | "failed", storageKey: string | null) {
  const source = await prisma.source.upsert({
    where: { name: "youtube" },
    create: { name: "youtube" },
    update: {},
  });
  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      sourceId: source.id,
      sourceVideoId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url: "https://www.youtube.com/watch?v=test",
      title: "Test video",
      category: "road_rage",
    },
  });
  const moment = await prisma.detectedMoment.create({
    data: {
      sourceVideoId: sourceVideo.id,
      category: "road_rage",
      title: "Test moment",
      description: "A car brakes suddenly",
      reason: "high conflict",
      startSeconds: 124.2,
      peakSeconds: 130,
      endSeconds: 157.8,
      scores: {},
      viralScore: 80,
      confidence: 0.9,
      status: "ready",
    },
  });
  await prisma.tikTokVersion.create({
    data: { momentId: moment.id, status: tikTokStatus, storageKey },
  });
  return moment;
}

async function cleanup(momentId: string) {
  const moment = await prisma.detectedMoment.findUnique({ where: { id: momentId } });
  await prisma.tikTokVersion.deleteMany({ where: { momentId } });
  await prisma.detectedMoment.deleteMany({ where: { id: momentId } });
  if (moment) await prisma.sourceVideo.deleteMany({ where: { id: moment.sourceVideoId } });
}

test("repairRender: unknown moment id returns not_found without touching the DB", async () => {
  const result = await repairRender("does-not-exist");
  assert.deepEqual(result, { outcome: "not_found" });
});

test("repairRender: DB record exists but bucket object is missing -> attempts a real repair, fails cleanly (no yt-dlp here) rather than hanging", async () => {
  // Points at a storage key nothing ever wrote — reproduces the real
  // production bug (a stale "ready"/"media_missing" TikTokVersion whose
  // object was lost). repairRender doesn't accept injected deps (matching
  // production, which always uses the real acquire/render/upload path), so
  // this exercises performRenderAndUpload for real. This sandbox has no
  // yt-dlp/ffmpeg on PATH, so the outcome is deterministically
  // "environment_broken" with a clear message — proving a missing render
  // fails loudly instead of hanging, and that it's the acquisition step
  // (not any AI call) that runs.
  const missingKey = storageKeyFor("nonexistent-object");
  assert.equal(await storage.exists(missingKey), false);
  const moment = await makeMoment("media_missing", missingKey);
  try {
    const result = await repairRender(moment.id);
    assert.equal(result.outcome, "environment_broken");
    assert.equal(result.errorKind, "binary_missing");
    assert.match(result.message ?? "", /yt-dlp/);

    const tikTokVersion = await prisma.tikTokVersion.findUniqueOrThrow({ where: { momentId: moment.id } });
    assert.equal(tikTokVersion.status, "failed");
    assert.notEqual(tikTokVersion.status, "ready");
  } finally {
    await cleanup(moment.id);
  }
});

test("repairRender never imports the AI/analysis layer (no Claude call during repair)", () => {
  const rerenderSrc = readFileSync(path.join(import.meta.dirname, "rerender.ts"), "utf8");
  assert.doesNotMatch(rerenderSrc, /@\/ai\//);
  assert.doesNotMatch(rerenderSrc, /@\/analysis\//);
});
