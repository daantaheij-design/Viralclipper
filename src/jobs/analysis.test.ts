import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prisma } from "@/database/client";
import { updateSettings } from "@/database/settings";
import { env } from "@/lib/env";
import { runAnalysis } from "./analysis";
import type { VideoProcessingStatus } from "@/generated/prisma";

async function makeCandidate(titleSuffix: string, status: VideoProcessingStatus = "discovered") {
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
      status,
      preliminaryScore: 50,
      // For status="waiting_for_ai" fixtures: pretend the free stage
      // already ran and found this clean, same as runLocalFilterOnVideo
      // would persist for real.
      ...(status === "waiting_for_ai" ? { sourceCleanlinessScore: 90 } : {}),
    },
  });
}

async function cleanupVideos(ids: string[]): Promise<void> {
  await prisma.detectedMoment.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.analysisJob.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.candidateWindow.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.sourceVideo.deleteMany({ where: { id: { in: ids } } });
}

async function statusesOf(ids: string[]): Promise<VideoProcessingStatus[]> {
  const rows = await prisma.sourceVideo.findMany({ where: { id: { in: ids } }, select: { status: true } });
  return rows.map((r) => r.status);
}

test("runAnalysis: two overlapping calls -> only one actually processes candidates (DB-backed analysis lock)", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 5 });
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

// --- Requirement A/B: free local filtering is NOT capped by maxQuickScansPerRun ---

test("runAnalysis: free local filtering processes up to freeLocalFilterBatchSize candidates, NOT maxQuickScansPerRun (the production bug this PR fixes)", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 5, maxQuickScansPerRun: 1 });
  // 10 pending candidates, a free batch size of 5, and a paid cap of 1 —
  // before this fix, the free stage was wrongly capped at
  // maxQuickScansPerRun (1 video/tick, matching the exact production log
  // line reported: "videosScanned: 1"). It must now process 5.
  const videos = await Promise.all(Array.from({ length: 10 }, (_, i) => makeCandidate(`backlog-${i}`)));
  try {
    const summary = await runAnalysis();
    assert.equal(summary.videosScanned, 5, `expected freeLocalFilterBatchSize (5) local candidates processed, got ${summary.videosScanned}`);
    assert.equal(summary.anthropicCallsAttempted, 0, "Paid AI Analysis is off — zero Anthropic attempts");
  } finally {
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("runAnalysis: the paid Anthropic batch is capped by maxQuickScansPerRun, independent of freeLocalFilterBatchSize", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 2 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  // 5 already-clean candidates (as if the free stage already processed
  // them on a prior tick) — none are "discovered", so the free batch has
  // nothing to do; only the paid batch's own take:maxQuickScansPerRun (2)
  // should touch any of them this tick. Real acquisition will fail for
  // these fake URLs (no network egress to YouTube in this sandbox) before
  // ever reaching Anthropic — which is fine for this assertion: touching a
  // candidate at all (moving it off waiting_for_ai) proves it was selected
  // by the paid query's take limit, regardless of what happens after.
  const videos = await Promise.all(Array.from({ length: 5 }, (_, i) => makeCandidate(`clean-${i}`, "waiting_for_ai")));
  try {
    await runAnalysis();
    const statuses = await statusesOf(videos.map((v) => v.id));
    const stillWaiting = statuses.filter((s) => s === "waiting_for_ai").length;
    const touched = statuses.filter((s) => s !== "waiting_for_ai").length;
    assert.equal(touched, 2, `expected exactly maxQuickScansPerRun (2) waiting_for_ai candidates touched, got ${touched}`);
    assert.equal(stillWaiting, 3, `expected the other 3 to remain untouched, got ${stillWaiting} still waiting`);
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos(videos.map((v) => v.id));
  }
});

// --- Requirement D: Paid AI OFF -> clean candidates rest at waiting_for_ai, untouched, zero Anthropic calls ---

test("runAnalysis: Paid AI Analysis OFF leaves existing waiting_for_ai candidates parked (never touched), zero Anthropic calls", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 5 });
  const videos = await Promise.all(Array.from({ length: 4 }, (_, i) => makeCandidate(`parked-${i}`, "waiting_for_ai")));
  try {
    const summary = await runAnalysis();
    assert.equal(summary.anthropicCallsAttempted, 0);
    const statuses = await statusesOf(videos.map((v) => v.id));
    assert.ok(
      statuses.every((s) => s === "waiting_for_ai"),
      `expected all 4 to remain waiting_for_ai with Paid AI off, got ${JSON.stringify(statuses)}`,
    );
  } finally {
    await cleanupVideos(videos.map((v) => v.id));
  }
});

// --- Requirement C/H: pre-existing backlog is picked up without rediscovery, and a second "restart" tick doesn't duplicate or lose it ---

test("runAnalysis: a pre-existing SourceVideo (created before this code ran, no discovery involved) is picked up by the free batch", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 1 });
  // Deliberately created directly via prisma, exactly like an old backlog
  // row from before this deploy — never touches runDiscoveryJob/runDiscovery.
  const video = await makeCandidate("legacy-backlog");
  try {
    const before = await prisma.sourceVideo.count();
    const summary = await runAnalysis();
    assert.ok(summary.videosScanned >= 1);
    const after = await prisma.sourceVideo.count();
    assert.equal(after, before, "no new SourceVideo rows should be created — only the existing one is processed");
    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.notEqual(updated.status, "discovered", "the pre-existing candidate must have moved off 'discovered'");
  } finally {
    await cleanupVideos([video.id]);
  }
});

test("runAnalysis: a second tick (simulating a worker restart) never reprocesses an already-handled candidate or creates duplicates", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 1 });
  const video = await makeCandidate("restart-check");
  try {
    await runAnalysis();
    const afterFirstTick = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.notEqual(afterFirstTick.status, "discovered");

    const countBeforeSecondTick = await prisma.sourceVideo.count({ where: { sourceVideoId: video.sourceVideoId } });
    await runAnalysis(); // simulates the next tick after a restart
    const countAfterSecondTick = await prisma.sourceVideo.count({ where: { sourceVideoId: video.sourceVideoId } });

    assert.equal(countAfterSecondTick, 1, "no duplicate row for the same sourceVideoId should ever be created");
    assert.equal(countAfterSecondTick, countBeforeSecondTick);
  } finally {
    await cleanupVideos([video.id]);
  }
});

// --- Requirement I: one bad/inaccessible source never aborts the rest of the free batch ---

test("runAnalysis: an individual candidate's acquisition failure doesn't abort the rest of the free batch", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 4, maxQuickScansPerRun: 1 });
  // Every candidate here uses a fake, unreachable source URL — every one
  // individually fails acquisition (this sandbox has no real network path
  // to YouTube), which is exactly "one bad/inaccessible source" repeated
  // four times. The batch must still report all 4 as processed, not stop
  // after the first failure or throw out of runAnalysis entirely.
  const videos = await Promise.all(Array.from({ length: 4 }, (_, i) => makeCandidate(`bad-source-${i}`)));
  try {
    const summary = await runAnalysis();
    assert.equal(summary.videosScanned, 4, "all 4 candidates must be attempted despite each one failing acquisition");
    const statuses = await statusesOf(videos.map((v) => v.id));
    assert.ok(statuses.every((s) => s !== "discovered" && s !== "scanning"), "every candidate must reach a terminal per-item status, not hang");
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

test("jobs/analysis.ts: the free local batch query is never bounded by maxQuickScansPerRun in the source text", async () => {
  const src = await readFile(new URL("./analysis.ts", import.meta.url), "utf8");
  const freeQueryStart = src.indexOf("async function runFreeLocalFilteringBatch");
  const freeQueryEnd = src.indexOf("async function runLocalFilterOnVideo");
  assert.ok(freeQueryStart > -1 && freeQueryEnd > freeQueryStart);
  const freeQuerySection = src.slice(freeQueryStart, freeQueryEnd);
  assert.doesNotMatch(
    freeQuerySection,
    /maxQuickScansPerRun/,
    "the free local filtering batch must be governed by freeLocalFilterBatchSize only, never maxQuickScansPerRun",
  );
  assert.match(freeQuerySection, /batchSize/);
});
