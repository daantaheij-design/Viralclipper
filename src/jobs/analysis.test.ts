import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma } from "@/database/client";
import { updateSettings } from "@/database/settings";
import { env } from "@/lib/env";
import { acquisitionEligible } from "@/database/acquisitionCooldown";
import { runAnalysis, summarizePersistedUsage, MAX_PAID_ANALYSIS_ATTEMPTS } from "./analysis";
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
    assert.equal(summary.anthropicRequestsCompleted, 0, "Paid AI Analysis is off — zero Anthropic requests");
    assert.equal(summary.actualCostUsd, 0);
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
    assert.equal(summary.anthropicRequestsCompleted, 0);
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

// --- Observability/state/cost-control fixes (production incident follow-up) ---

test("summarizePersistedUsage: derives request-level counts EXACTLY from persisted ApiUsage rows — never fewer than what's actually persisted", async () => {
  const runToken = randomUUID();
  const videoAId = `video-a-${randomUUID()}`;
  const videoBId = `video-b-${randomUUID()}`;
  try {
    // Simulates exactly the production incident's shape: one candidate
    // (video A) got a quick scan AND a detailed analysis (2 requests, 1
    // candidate); a second, unrelated request landed against video B.
    await prisma.apiUsage.createMany({
      data: [
        { provider: "anthropic", operation: "quick_scan", costUsd: 0.4, sourceVideoId: videoAId, runToken },
        { provider: "anthropic", operation: "detailed_analysis", costUsd: 0.35, sourceVideoId: videoAId, runToken },
        { provider: "anthropic", operation: "quick_scan", costUsd: 0.2, sourceVideoId: videoBId, runToken },
        // A different run's row must never leak into this run's summary.
        { provider: "anthropic", operation: "quick_scan", costUsd: 999, sourceVideoId: videoAId, runToken: `${runToken}-other` },
      ],
    });

    const summary = await summarizePersistedUsage(runToken);
    assert.equal(summary.completed, 3, "must report exactly the 3 rows persisted for this runToken — never 0, never fewer");
    assert.equal(summary.quickScans, 2);
    assert.equal(summary.detailedAnalyses, 1);
    assert.equal(summary.uniqueSourceVideoIds, 2, "video A contributed 2 requests but is still 1 unique video");
    assert.ok(Math.abs(summary.actualCostUsd - 0.95) < 1e-9, `expected actualCostUsd ~0.95, got ${summary.actualCostUsd}`);
  } finally {
    await prisma.apiUsage.deleteMany({ where: { runToken: { in: [runToken, `${runToken}-other`] } } });
  }
});

test("summarizePersistedUsage: zero persisted rows -> zero everywhere (nothing to fabricate)", async () => {
  const runToken = randomUUID();
  const summary = await summarizePersistedUsage(runToken);
  assert.deepEqual(summary, { completed: 0, quickScans: 0, detailedAnalyses: 0, uniqueSourceVideoIds: 0, actualCostUsd: 0 });
});

test("runAnalysis: a candidate that already reached MAX_PAID_ANALYSIS_ATTEMPTS is excluded from the paid batch (never silently retried forever)", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 5 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  const exhausted = await makeCandidate("exhausted", "waiting_for_ai");
  const fresh = await makeCandidate("fresh", "waiting_for_ai");
  try {
    await prisma.sourceVideo.update({ where: { id: exhausted.id }, data: { paidAnalysisAttempts: 3 } });

    await runAnalysis();

    const exhaustedAfter = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: exhausted.id } });
    assert.equal(exhaustedAfter.status, "waiting_for_ai", "an already-capped candidate must never be re-selected into the paid batch");
    assert.equal(exhaustedAfter.paidAnalysisAttempts, 3, "its attempt counter must not increment further — it was never touched");

    // The fresh candidate, by contrast, WAS selected (real acquisition
    // fails for this fake URL in this sandbox with no network egress, but
    // being touched at all — leaving waiting_for_ai, attempts incremented
    // — proves it was selected by the paid query, unlike the capped one).
    const freshAfter = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: fresh.id } });
    assert.ok(freshAfter.paidAnalysisAttempts >= 1, "expected the fresh candidate to have entered the paid batch and incremented its attempt count");
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([exhausted.id, fresh.id]);
  }
});

test("runAnalysis: a candidate already in a terminal AI outcome state is never re-selected by a later tick", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 5 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  const terminalStatuses: VideoProcessingStatus[] = [
    "ai_rejected_quick",
    "ai_rejected_detailed",
    "ai_rejected_below_score",
    "ai_failed",
    "scanned",
  ];
  const videos = await Promise.all(terminalStatuses.map((s, i) => makeCandidate(`terminal-${i}`, s)));
  try {
    await runAnalysis();
    const rows = await prisma.sourceVideo.findMany({
      where: { id: { in: videos.map((v) => v.id) } },
      select: { id: true, status: true },
    });
    for (const video of videos) {
      const row = rows.find((r) => r.id === video.id);
      assert.equal(row?.status, video.status, `expected ${video.id} (seeded as ${video.status}) to remain untouched`);
    }
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("jobs/analysis.ts: runPaidAnthropicBatch's returned counts are derived from summarizePersistedUsage, not a separate in-memory tally (source text)", async () => {
  const src = await readFile(new URL("./analysis.ts", import.meta.url), "utf8");
  const batchFnStart = src.indexOf("async function runPaidAnthropicBatch");
  const batchFnEnd = src.indexOf("interface PersistedUsageSummary");
  assert.ok(batchFnStart > -1 && batchFnEnd > batchFnStart);
  const section = src.slice(batchFnStart, batchFnEnd);
  assert.match(section, /summarizePersistedUsage\(runToken\)/, "the batch result must be derived from the persisted-usage query");
  assert.match(
    section,
    /anthropicRequestsCompleted:\s*persisted\.completed/,
    "anthropicRequestsCompleted must come from the persisted query result, not an in-memory counter",
  );
});

test("jobs/analysis.ts: the paid batch query excludes candidates at or past MAX_PAID_ANALYSIS_ATTEMPTS (source text)", async () => {
  const src = await readFile(new URL("./analysis.ts", import.meta.url), "utf8");
  const batchFnStart = src.indexOf("async function runPaidAnthropicBatch");
  const batchFnEnd = src.indexOf("const runToken = generateRunToken();");
  assert.ok(batchFnStart > -1 && batchFnEnd > batchFnStart);
  const section = src.slice(batchFnStart, batchFnEnd);
  assert.match(section, /paidAnalysisAttempts:\s*\{\s*lt:\s*MAX_PAID_ANALYSIS_ATTEMPTS\s*\}/);
});

// --- Paid queue selection fix (production incident: worker selected 0 of 55 waiting_for_ai candidates) ---

/**
 * All tests below force a deterministic, real (not mocked) media-acquisition
 * failure by pointing env.ytDlpPath at a nonexistent binary for the test's
 * duration — this reproduces `binary_missing`/`environmentBroken` exactly
 * the way the real production incident did, without ever touching network
 * or Anthropic. Same established pattern as this suite's existing use of
 * env.anthropicApiKey (see src/ai/budget.test.ts).
 */
async function withBrokenYtDlp<T>(fn: () => Promise<T>): Promise<T> {
  const before = env.ytDlpPath;
  env.ytDlpPath = "/nonexistent/yt-dlp-binary-for-tests";
  try {
    return await fn();
  } finally {
    env.ytDlpPath = before;
  }
}

test("runAnalysis: a waiting_for_ai candidate IS selected by the paid worker even when the free batch's environment is broken (production regression)", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 1 });
  const beforeKey = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  // One free-batch candidate (will hit binary_missing and set
  // local.environmentBroken=true) plus one pre-existing waiting_for_ai
  // candidate created directly via prisma — exactly like a real production
  // backlog row that survived a prior deploy, never touching discovery.
  const freeBatchVictim = await makeCandidate("free-batch-victim");
  const waitingCandidate = await makeCandidate("preexisting-waiting", "waiting_for_ai");
  try {
    const countBefore = await prisma.sourceVideo.count();

    await withBrokenYtDlp(() => runAnalysis());

    const countAfter = await prisma.sourceVideo.count();
    assert.equal(countAfter, countBefore, "no new SourceVideo rows — the existing candidate must not be rediscovered or duplicated");

    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: waitingCandidate.id } });
    assert.ok(
      updated.paidAnalysisAttempts >= 1,
      `expected the pre-existing waiting_for_ai candidate to be selected and attempted by the paid batch (paidAnalysisAttempts >= 1), got ${updated.paidAnalysisAttempts} — before the fix, a broken free-batch environment silently skipped the entire paid batch`,
    );
    assert.notEqual(updated.status, "waiting_for_ai", "having been selected and attempted, it must leave waiting_for_ai (not sit forever looking untouched)");
    assert.notEqual(updated.status, "ai_processing", "a failed attempt must not leave the candidate stuck in the transient ai_processing state");
  } finally {
    env.anthropicApiKey = beforeKey;
    await cleanupVideos([freeBatchVictim.id, waitingCandidate.id]);
  }
});

test("runAnalysis: Paid AI OFF leaves waiting_for_ai candidates untouched even when the free batch's environment is broken", async () => {
  await updateSettings({ paidAiAnalysisEnabled: false, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 5 });
  const freeBatchVictim = await makeCandidate("free-batch-victim-off");
  const waitingCandidate = await makeCandidate("waiting-off", "waiting_for_ai");
  try {
    const summary = await withBrokenYtDlp(() => runAnalysis());
    assert.equal(summary.anthropicRequestsCompleted, 0);

    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: waitingCandidate.id } });
    assert.equal(updated.status, "waiting_for_ai");
    assert.equal(updated.paidAnalysisAttempts, 0, "Paid AI is off — the candidate must not be selected or attempted at all");
  } finally {
    await cleanupVideos([freeBatchVictim.id, waitingCandidate.id]);
  }
});

test("runAnalysis: with maxQuickScansPerRun=1, exactly 1 of several waiting_for_ai candidates is selected — never 0", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 1 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  const videos = await Promise.all(Array.from({ length: 5 }, (_, i) => makeCandidate(`selection-${i}`, "waiting_for_ai")));
  try {
    await runAnalysis();
    const rows = await prisma.sourceVideo.findMany({ where: { id: { in: videos.map((v) => v.id) } }, select: { id: true, paidAnalysisAttempts: true } });
    const selected = rows.filter((r) => r.paidAnalysisAttempts > 0);
    assert.equal(selected.length, 1, `expected exactly 1 of 5 waiting_for_ai candidates selected with maxQuickScansPerRun=1, got ${selected.length}`);
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("runAnalysis: two concurrent invocations never select the same waiting_for_ai candidate twice", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 1 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  const videos = await Promise.all(Array.from({ length: 2 }, (_, i) => makeCandidate(`concurrent-${i}`, "waiting_for_ai")));
  try {
    await Promise.all([runAnalysis(), runAnalysis()]);
    const rows = await prisma.sourceVideo.findMany({ where: { id: { in: videos.map((v) => v.id) } }, select: { paidAnalysisAttempts: true } });
    const totalAttempts = rows.reduce((sum, r) => sum + r.paidAnalysisAttempts, 0);
    assert.ok(
      totalAttempts <= 1,
      `two concurrent runAnalysis() calls with maxQuickScansPerRun=1 must select at most 1 candidate total (the DB-backed analysis lock serializes them) — got ${totalAttempts} total attempts across both`,
    );
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("runAnalysis: a media-acquisition failure before any Anthropic call leaves zero ApiUsage rows and an explicit terminal status, not stuck in ai_processing", async () => {
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100, freeLocalFilterBatchSize: 25, maxQuickScansPerRun: 1 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  const video = await makeCandidate("acquisition-fails", "waiting_for_ai");
  try {
    await withBrokenYtDlp(() => runAnalysis());

    const usageCount = await prisma.apiUsage.count({ where: { sourceVideoId: video.id } });
    assert.equal(usageCount, 0, "media acquisition failed before any Anthropic call — zero ApiUsage rows must exist");

    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.notEqual(updated.status, "ai_processing", "must not be left stuck in the transient processing state");
    assert.notEqual(updated.status, "waiting_for_ai", "a real attempt was made — it must not look untouched");
    assert.equal(updated.paidAnalysisAttempts, 1, "the attempt must still be counted toward the retry cap");
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("waiting_for_ai eligibility: the dashboard's count query and the paid worker's eligible-candidate query agree for a fresh backlog", async () => {
  const videos = await Promise.all(Array.from({ length: 4 }, (_, i) => makeCandidate(`consistency-${i}`, "waiting_for_ai")));
  try {
    const dashboardCount = await prisma.sourceVideo.count({
      where: { status: "waiting_for_ai", id: { in: videos.map((v) => v.id) } },
    });
    const paidEligibleCount = await prisma.sourceVideo.count({
      where: {
        AND: [
          { status: "waiting_for_ai" },
          { id: { in: videos.map((v) => v.id) } },
          { paidAnalysisAttempts: { lt: MAX_PAID_ANALYSIS_ATTEMPTS } },
          acquisitionEligible(new Date()),
        ],
      },
    });
    assert.equal(dashboardCount, 4);
    assert.equal(
      paidEligibleCount,
      dashboardCount,
      "a fresh waiting_for_ai backlog (0 paid attempts, never access-blocked) must be exactly as eligible for paid selection as the dashboard's plain status count says it is",
    );
  } finally {
    await cleanupVideos(videos.map((v) => v.id));
  }
});

test("jobs/analysis.ts: paid selection is never gated on the free batch's environmentBroken result (source text)", async () => {
  const src = await readFile(new URL("./analysis.ts", import.meta.url), "utf8");
  const gateStart = src.indexOf("const aiAvailable = settings.paidAiAnalysisEnabled");
  assert.ok(gateStart > -1);
  // The ternary driving `paid` (a few lines below `aiAvailable`) must never
  // reference local.environmentBroken.
  const section = src.slice(gateStart, gateStart + 400);
  assert.doesNotMatch(
    section,
    /local\.environmentBroken/,
    "runPaidAnthropicBatch's invocation must never be conditioned on the free batch's environmentBroken result",
  );
});

test("jobs/analysis.ts: a candidate is transitioned to ai_processing before any acquisition/Anthropic call (source text)", async () => {
  const src = await readFile(new URL("./analysis.ts", import.meta.url), "utf8");
  const fnStart = src.indexOf("async function runPaidAnalysisOnVideo");
  const fnEnd = src.indexOf("async function acquireSourceFile");
  assert.ok(fnStart > -1 && fnEnd > fnStart);
  const section = src.slice(fnStart, fnEnd);
  const statusUpdateIndex = section.indexOf('status: "ai_processing"');
  const acquireCallIndex = section.indexOf("await acquireSourceFile(video, scratchDir)");
  assert.ok(statusUpdateIndex > -1 && acquireCallIndex > -1);
  assert.ok(statusUpdateIndex < acquireCallIndex, "the ai_processing transition must happen before acquisition (and therefore before any Anthropic call)");
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
