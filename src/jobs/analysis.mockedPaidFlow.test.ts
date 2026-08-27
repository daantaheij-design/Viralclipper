import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import { prisma } from "@/database/client";
import { updateSettings } from "@/database/settings";
import { estimateInputTokens, estimateCostUsd, estimateMaxCostUsd } from "@/ai/pricing";
import { AiBudgetBlockedError, commitReservation, releaseReservation, reserveAiBudget } from "@/ai/budget";
import { recordApiUsage } from "@/ai/costTracking";
import type { VisionAnalysisInput } from "@/ai/providers/claude";

/**
 * The only test file in this suite that mocks Anthropic — required because
 * these scenarios (quick-pass, quick-reject, detailed-budget-exhaustion,
 * exact request counts) can only be exercised by actually completing a
 * quick-scan/detailed-analysis call, which needs either a real Anthropic key
 * (never — see CLAUDE.md/README) or a mock. Per the production incident this
 * fixes (one candidate silently fanning out into 3 quick_scan requests,
 * ~$1.10 spent), never use a real ANTHROPIC_API_KEY here.
 *
 * The mock replaces ONLY `analyzeFrames`'s literal network call to Anthropic
 * — `fakeAnalyzeFrames` below reimplements everything else in the real
 * function (reserveAiBudget, commitReservation/releaseReservation,
 * recordApiUsage, real cost computation from the response's token counts)
 * by calling the exact same real, already-independently-tested modules
 * (src/ai/budget.ts, src/ai/costTracking.ts, src/ai/pricing.ts) production
 * does. This means the real budget gate, real ApiUsage persistence, and
 * real cost math are still exercised for real — only the HTTP round-trip to
 * Anthropic itself is faked.
 *
 * Media acquisition is also mocked (`@/video/acquire::acquireVideo`) to
 * return a real local ffmpeg-generated synthetic video instead of touching
 * the network — this sandbox has no route to YouTube/Reddit, matching the
 * rest of this test suite's established pattern (see quickScan.test.ts).
 *
 * Requires `node --experimental-test-module-mocks` (see package.json's
 * `test` script) — `mock.module` only reliably intercepts LOCAL project
 * modules resolved through tsx's own path-alias resolver, not third-party
 * packages like `@anthropic-ai/sdk` itself (confirmed empirically: mocking
 * the SDK's default export did not stop a real, if harmless, 401 network
 * request to api.anthropic.com — mocking `@/ai/providers/claude` instead
 * does not touch the network at all).
 */

let sourceVideoPath = "";

async function makeSyntheticVideo(durationSeconds: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mocked-paid-flow-"));
  const videoPath = path.join(dir, "source.mp4");
  await run(env.ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=1920x1080:rate=4:duration=${durationSeconds}`,
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  return videoPath;
}

type FakeResponse = { inputTokens: number; outputTokens: number; data: unknown };
type ResponseProvider = (input: VisionAnalysisInput<never>) => Promise<FakeResponse>;

let responseProvider: ResponseProvider = async () => {
  throw new Error("responseProvider not configured for this test");
};
let quickScanCallCount = 0;
let detailedAnalysisCallCount = 0;
let lastQuickScanFrames: VisionAnalysisInput<never> | null = null;

/** Reset per-test call-tracking state. */
function resetCallTracking(): void {
  quickScanCallCount = 0;
  detailedAnalysisCallCount = 0;
  lastQuickScanFrames = null;
}

async function fakeAnalyzeFrames(input: VisionAnalysisInput<never>) {
  const maxTokens = input.maxTokens ?? 8000;
  const estimatedCostUsd = estimateCostUsd(env.claudeModel, estimateInputTokens(input.frames.length, input.frameDimensions), maxTokens);

  const reservation = await reserveAiBudget({
    kind: input.operation,
    estimatedCostUsd,
    runToken: input.runToken,
    sourceVideoId: input.sourceVideoId,
    momentId: input.momentId,
  });
  if (!reservation.ok) throw new AiBudgetBlockedError(reservation.reason, reservation.message);

  // Only counted once the reservation actually succeeded — i.e. once a
  // real request is genuinely about to happen — so these counters measure
  // real (would-be-billed) attempts, not every call into this function
  // (a budget-blocked reservation must not count as "a request happened").
  if (input.operation === "quick_scan") {
    quickScanCallCount++;
    lastQuickScanFrames = input;
  } else {
    detailedAnalysisCallCount++;
  }

  let committed = false;
  try {
    const response = await responseProvider(input);
    const costUsd = estimateCostUsd(env.claudeModel, response.inputTokens, response.outputTokens);
    await commitReservation(reservation.reservationId, costUsd);
    committed = true;
    await recordApiUsage({
      provider: "anthropic",
      operation: input.operation,
      model: env.claudeModel,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
      estimatedCostUsd,
      costUsd,
      sourceVideoId: input.sourceVideoId,
      momentId: input.momentId,
      analysisJobId: input.analysisJobId,
      runToken: input.runToken,
    });
    return { data: response.data, inputTokens: response.inputTokens, outputTokens: response.outputTokens, costUsd };
  } catch (err) {
    if (!committed) await releaseReservation(reservation.reservationId);
    throw err;
  }
}

mock.module("@/ai/providers/claude", { namedExports: { analyzeFrames: fakeAnalyzeFrames } });
mock.module("@/video/acquire", {
  namedExports: {
    acquireVideo: async (_availability: unknown, destDir: string): Promise<string> => {
      await mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, "source.mp4");
      await copyFile(sourceVideoPath, dest);
      return dest;
    },
  },
});

// Imported dynamically (inside this helper, called from within each test
// body — tsx's CJS transform for this file doesn't support top-level
// await), AFTER the mock.module calls above register: a static top-level
// `import` would resolve (and cache) the REAL @/ai/providers/claude and
// @/video/acquire before the mocks ever apply. The dynamic import itself is
// cached by the module loader after the first call, so this costs nothing
// on repeat calls within the same test file/process.
async function runAnalysis() {
  return (await import("./analysis")).runAnalysis();
}

function highScores() {
  const s = 90;
  return {
    hook: s,
    visual_action: s,
    conflict: s,
    escalation: s,
    surprise: s,
    emotion: s,
    payoff: s,
    understandability: s,
    retention: s,
    rewatch: s,
    tiktok_suitability: s,
  };
}

function lowScores() {
  const s = 20;
  return {
    hook: s,
    visual_action: s,
    conflict: s,
    escalation: s,
    surprise: s,
    emotion: s,
    payoff: s,
    understandability: s,
    retention: s,
    rewatch: s,
    tiktok_suitability: s,
  };
}

function detailedMoment(scores: ReturnType<typeof highScores>) {
  return {
    title: "Test moment",
    category: "road_rage",
    description: "A vehicle brakes suddenly in front of another.",
    reason: "Sudden, unexpected action",
    start_seconds: 12,
    peak_seconds: 15,
    end_seconds: 20,
    confidence: 0.9,
    scores,
    tracked_keyframes: [],
  };
}

async function makeWaitingCandidate(titleSuffix: string, preliminaryScore = 50) {
  const source = await prisma.source.upsert({ where: { name: "youtube" }, create: { name: "youtube" }, update: {} });
  return prisma.sourceVideo.create({
    data: {
      sourceId: source.id,
      sourceVideoId: `mocked-${Date.now()}-${titleSuffix}-${Math.random().toString(36).slice(2)}`,
      url: "https://www.youtube.com/watch?v=test",
      title: `Mocked candidate ${titleSuffix}`,
      category: "road_rage",
      status: "waiting_for_ai",
      preliminaryScore,
      sourceCleanlinessScore: 90,
    },
  });
}

async function cleanupVideos(ids: string[]): Promise<void> {
  await prisma.detectedMoment.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.analysisJob.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.candidateWindow.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.apiUsage.deleteMany({ where: { sourceVideoId: { in: ids } } });
  await prisma.sourceVideo.deleteMany({ where: { id: { in: ids } } });
}

const SAFE_PRODUCTION_SETTINGS = {
  paidAiAnalysisEnabled: true,
  dailyAiBudgetUsd: 1.0,
  perRunAiBudgetUsd: 0,
  maxConcurrentAnthropicCalls: 1,
  maxPaidCandidatesPerRun: 1,
  maxQuickAnthropicRequestsPerCandidate: 1,
  maxDetailedAnthropicRequestsPerCandidate: 1,
  freeLocalFilterBatchSize: 25,
  // Explicit (not relying on DEFAULT_SETTINGS) — settings are a single
  // shared Postgres row across every test file in this suite, and other
  // files' own updateSettings calls can interleave at the module-load
  // phase (see quickScan.test.ts's comment on the same hazard), so every
  // value a test's assertions depend on must be set explicitly here.
  minViralScore: 70,
};

test("setup: build a synthetic 20-minute source video once (long enough that the OLD design needed multiple quick_scan batches)", async () => {
  sourceVideoPath = await makeSyntheticVideo(20 * 60);
  assert.ok(sourceVideoPath);
});

test("1/2/3: a selected candidate generates AT MOST ONE quick Anthropic request, even for a long source (never silently fans out)", async () => {
  await updateSettings(SAFE_PRODUCTION_SETTINGS);
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async () => ({ inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [] } });

  const video = await makeWaitingCandidate("long-source");
  try {
    await runAnalysis();
    assert.equal(quickScanCallCount, 1, `expected exactly 1 quick_scan request for a 20-minute source, got ${quickScanCallCount}`);
    assert.equal(detailedAnalysisCallCount, 0);

    const usageRows = await prisma.apiUsage.findMany({ where: { sourceVideoId: video.id, operation: "quick_scan" } });
    assert.equal(usageRows.length, 1, "exactly 1 persisted quick_scan ApiUsage row — the request-level enforcement this incident needed");
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("4: quick scan sends the new low-resolution, bounded-frame-count payload (never native resolution, never dozens of frames)", async () => {
  await updateSettings(SAFE_PRODUCTION_SETTINGS);
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async () => ({ inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [] } });

  const video = await makeWaitingCandidate("resolution-check");
  try {
    await runAnalysis();
    assert.ok(lastQuickScanFrames, "expected the quick_scan request to have been captured");
    assert.deepEqual(lastQuickScanFrames?.frameDimensions, { width: 512, height: 288 });
    assert.ok(
      lastQuickScanFrames!.frames.length >= 6 && lastQuickScanFrames!.frames.length <= 12,
      `expected 6-12 frames, got ${lastQuickScanFrames!.frames.length}`,
    );
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("5: new quick-scan max estimated cost is far below the old production incident's ~$0.7952 reservation", () => {
  // The incident: 40 native-1080p frames, maxTokens 4000.
  const oldEstimate = estimateMaxCostUsd("claude-opus-5", 40, 4000, { width: 1920, height: 1080 });
  assert.ok(Math.abs(oldEstimate - 0.7952) < 0.01, `sanity check: old design's estimate should reproduce ~$0.7952, got $${oldEstimate}`);

  // The new design: up to 12 frames, 512x288, maxTokens 1500 (quickScan.ts's constants).
  const newEstimate = estimateMaxCostUsd("claude-opus-5", 12, 1500, { width: 512, height: 288 });
  assert.ok(newEstimate <= 0.1, `expected new estimate <= $0.10, got $${newEstimate}`);
  assert.ok(newEstimate < oldEstimate / 5, `expected the new estimate to be at least 5x cheaper than the old one, got $${newEstimate} vs $${oldEstimate}`);
});

test("6: quick reject performs exactly 1 quick request and 0 detailed requests", async () => {
  await updateSettings(SAFE_PRODUCTION_SETTINGS);
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async () => ({ inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [] } });

  const video = await makeWaitingCandidate("quick-reject");
  try {
    await runAnalysis();
    assert.equal(quickScanCallCount, 1);
    assert.equal(detailedAnalysisCallCount, 0);
    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.equal(updated.status, "ai_rejected_quick");
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("7: quick pass performs exactly 1 quick request then at most 1 detailed request", async () => {
  // Detailed analysis isn't mocked below the analyzeFrames boundary — it
  // still runs real frame extraction against the real (native-1080p)
  // synthetic video, so its real pre-call reservation estimate is much
  // larger than quick scan's. A generous daily budget here isolates this
  // test to what it's actually checking (request counts / final status),
  // not budget exhaustion — that's covered separately by tests 8/9.
  await updateSettings({ ...SAFE_PRODUCTION_SETTINGS, dailyAiBudgetUsd: 5, perRunAiBudgetUsd: 0 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async (input) => {
    if (input.operation === "quick_scan") {
      return { inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [{ startSeconds: 10, endSeconds: 40, reason: "brake check" }] } };
    }
    return { inputTokens: 5000, outputTokens: 800, data: { interesting_moment: true, moments: [detailedMoment(highScores())] } };
  };

  const video = await makeWaitingCandidate("quick-pass");
  try {
    await runAnalysis();
    assert.equal(quickScanCallCount, 1);
    assert.equal(detailedAnalysisCallCount, 1, `expected at most 1 detailed request, got ${detailedAnalysisCallCount}`);
    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.equal(updated.status, "scanned", "a moment scoring 90 (>= default minViralScore 70) must reach 'scanned'");
    const moments = await prisma.detectedMoment.count({ where: { sourceVideoId: video.id } });
    assert.equal(moments, 1);
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("8/9: if the detailed reservation cannot fit the remaining budget, no second quick scan occurs and the candidate exits ai_processing into a safe terminal state (not stuck, not silently re-chargeable)", async () => {
  // A budget just big enough for one cheap quick-scan reservation but not
  // for a subsequent detailed-analysis reservation.
  const quickEstimate = estimateMaxCostUsd("claude-opus-5", 12, 1500, { width: 512, height: 288 });
  await updateSettings({
    ...SAFE_PRODUCTION_SETTINGS,
    dailyAiBudgetUsd: quickEstimate + 0.001,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async (input) => {
    if (input.operation === "quick_scan") {
      // Actual cost intentionally close to the reservation so almost
      // nothing is left over for a detailed reservation.
      return { inputTokens: 2500, outputTokens: 1400, data: { candidateWindows: [{ startSeconds: 5, endSeconds: 30, reason: "test" }] } };
    }
    throw new Error("detailed_analysis must never actually be called in this scenario");
  };

  const video = await makeWaitingCandidate("budget-exhausted");
  try {
    await runAnalysis();
    assert.equal(quickScanCallCount, 1, "quick scan runs exactly once");
    assert.equal(detailedAnalysisCallCount, 0, "detailed analysis must never be attempted once its reservation is blocked");

    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.equal(updated.status, "ai_budget_exhausted");
    assert.notEqual(updated.status, "ai_processing", "must not be stuck in the transient processing state");
    assert.notEqual(updated.status, "waiting_for_ai", "must not silently become re-chargeable on a future tick");

    // Re-running analysis must NOT trigger a second quick scan for this
    // candidate — it already left waiting_for_ai for good.
    await runAnalysis();
    assert.equal(quickScanCallCount, 1, "a second tick must not re-charge this candidate's quick scan");
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("10: Paid AI OFF makes zero Anthropic requests", async () => {
  await updateSettings({ ...SAFE_PRODUCTION_SETTINGS, paidAiAnalysisEnabled: false });
  resetCallTracking();
  responseProvider = async () => {
    throw new Error("must never be called with Paid AI off");
  };

  const video = await makeWaitingCandidate("paid-off");
  try {
    const summary = await runAnalysis();
    assert.equal(quickScanCallCount, 0);
    assert.equal(summary.anthropicRequestsCompleted, 0);
    const updated = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: video.id } });
    assert.equal(updated.status, "waiting_for_ai");
  } finally {
    await cleanupVideos([video.id]);
  }
});

test("11: the rest of the waiting_for_ai backlog is preserved untouched", async () => {
  await updateSettings(SAFE_PRODUCTION_SETTINGS); // maxPaidCandidatesPerRun: 1
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async () => ({ inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [] } });

  // Distinct preliminaryScore so the paid query's `orderBy: { preliminaryScore: "desc" }`
  // deterministically picks "selected" — a tie would make which candidate
  // gets chosen unspecified, and this test needs to know exactly which one
  // did.
  const selected = await makeWaitingCandidate("selected", 100);
  const backlog = await Promise.all(Array.from({ length: 4 }, (_, i) => makeWaitingCandidate(`backlog-${i}`, 10)));
  try {
    await runAnalysis();
    assert.equal(quickScanCallCount, 1, "only the one selected candidate should generate a request");

    const backlogRows = await prisma.sourceVideo.findMany({ where: { id: { in: backlog.map((v) => v.id) } } });
    assert.ok(
      backlogRows.every((r) => r.status === "waiting_for_ai" && r.paidAnalysisAttempts === 0),
      "the untouched backlog must remain exactly as it was — no rediscovery, no duplication, no processing",
    );
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([selected.id, ...backlog.map((v) => v.id)]);
  }
});

test("12: one video receiving both a quick and a detailed request still counts as exactly 1 unique paid candidate", async () => {
  // See test 7's comment — detailed analysis's real frame extraction needs
  // a generous budget to actually complete rather than being blocked.
  await updateSettings({ ...SAFE_PRODUCTION_SETTINGS, dailyAiBudgetUsd: 5, perRunAiBudgetUsd: 0 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async (input) => {
    if (input.operation === "quick_scan") {
      return { inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [{ startSeconds: 10, endSeconds: 40, reason: "test" }] } };
    }
    return { inputTokens: 5000, outputTokens: 800, data: { interesting_moment: true, moments: [detailedMoment(lowScores())] } };
  };

  const video = await makeWaitingCandidate("unique-metric");
  try {
    const summary = await runAnalysis();
    assert.equal(summary.anthropicRequestsCompleted, 2, "2 real requests (1 quick + 1 detailed)");
    assert.equal(summary.paidCandidatesProcessed, 1, "still exactly 1 unique video, not 2");

    const videosSentGroups = await prisma.apiUsage.groupBy({ by: ["sourceVideoId"], where: { provider: "anthropic", sourceVideoId: video.id } });
    assert.equal(videosSentGroups.length, 1);
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("13: two concurrent worker invocations cannot both process the same paid candidate", async () => {
  await updateSettings(SAFE_PRODUCTION_SETTINGS);
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  resetCallTracking();
  responseProvider = async () => ({ inputTokens: 3000, outputTokens: 200, data: { candidateWindows: [] } });

  const video = await makeWaitingCandidate("concurrent");
  try {
    await Promise.all([runAnalysis(), runAnalysis()]);
    assert.equal(quickScanCallCount, 1, `expected exactly 1 quick_scan call across 2 concurrent ticks (DB-backed analysis lock), got ${quickScanCallCount}`);
  } finally {
    env.anthropicApiKey = before;
    await cleanupVideos([video.id]);
  }
});

test("teardown: remove the synthetic source video", async () => {
  if (sourceVideoPath) await rm(path.dirname(sourceVideoPath), { recursive: true, force: true }).catch(() => {});
});
