import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prisma } from "@/database/client";
import { updateSettings } from "@/database/settings";
import { runAnalysis } from "./analysis";

async function makeCandidate(titleSuffix: string) {
  const source = await prisma.source.upsert({
    where: { name: "youtube" },
    create: { name: "youtube" },
    update: {},
  });
  return prisma.sourceVideo.create({
    data: {
      sourceId: source.id,
      sourceVideoId: `test-${Date.now()}-${titleSuffix}-${Math.random().toString(36).slice(2)}`,
      url: "https://www.youtube.com/watch?v=test",
      title: `Test candidate ${titleSuffix}`,
      category: "road_rage",
      status: "discovered",
      preliminaryScore: 50,
    },
  });
}

async function cleanupVideos(ids: string[]): Promise<void> {
  await prisma.detectedMoment.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.analysisJob.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.candidateWindow.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.sourceVideo.deleteMany({ where: { id: { in: ids } } });
}

test("runAnalysis: two overlapping calls -> only one actually processes candidates (DB-backed analysis lock)", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, maxQuickScansPerRun: 5 });
  const videos = await Promise.all([makeCandidate("a"), makeCandidate("b")]);
  try {
    const [first, second] = await Promise.all([runAnalysis(), runAnalysis()]);
    const results = [first, second];
    const skipped = results.filter((r) => r.skippedAlreadyRunning);
    const ran = results.filter((r) => !r.skippedAlreadyRunning);

    assert.equal(skipped.length, 1, `expected exactly 1 of 2 overlapping calls to be skipped, got ${skipped.length}`);
    assert.equal(ran.length, 1);
  } finally {
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("runAnalysis: a large backlog never translates into more than maxQuickScansPerRun attempts", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, maxQuickScansPerRun: 3 });
  // Reproduces the "300 discovered candidates must NOT mean 300 Claude
  // scans" scenario at a small scale — 10 eligible candidates, cap of 3.
  const videos = await Promise.all(Array.from({ length: 10 }, (_, i) => makeCandidate(`backlog-${i}`)));
  try {
    const summary = await runAnalysis();
    assert.equal(summary.videosScanned, 3, `expected exactly maxQuickScansPerRun (3) attempts, got ${summary.videosScanned}`);
  } finally {
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("jobs/analysis.ts: the local cleanliness gate runs before any Anthropic call in the source text", async () => {
  const src = await readFile(new URL("./analysis.ts", import.meta.url), "utf8");
  const cleanlinessCallIndex = src.indexOf("scanSourceCleanliness(");
  const quickScanCallIndex = src.indexOf("runQuickScan(");
  assert.ok(cleanlinessCallIndex > -1, "scanSourceCleanliness(...) call not found");
  assert.ok(quickScanCallIndex > -1, "runQuickScan(...) call not found");
  assert.ok(
    cleanlinessCallIndex < quickScanCallIndex,
    "the local source-cleanliness scan must run before the first Anthropic-calling step (runQuickScan)",
  );
});
