import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { acquisitionEligible, markSourceVideoAccessBlocked } from "@/database/acquisitionCooldown";
import { tryAcquireLock, releaseLock } from "@/database/jobLock";
import { generateRunToken, AiBudgetBlockedError } from "@/ai/budget";
import { env } from "@/lib/env";
import { getSource } from "@/sources/registry";
import { probeVideo } from "@/video/ffmpeg";
import { acquireVideo } from "@/video/acquire";
import { AcquisitionError } from "@/video/acquisitionErrors";
import { AcquisitionCircuitBreaker } from "@/video/acquisitionThrottle";
import { scratchDirForSourceVideo, cleanupScratchDir } from "@/lib/scratch";
import { scanSourceCleanliness, suggestCleanSourceQueries } from "@/analysis/sourceCleanliness";
import { runQuickScan } from "@/analysis/quickScan";
import { runDetailedAnalysis } from "@/analysis/detailedAnalysis";
import { computeViralScore } from "@/scoring/viralScore";
import { logError } from "@/lib/errorLog";
import type { Prisma } from "@/generated/prisma";

type SourceVideoWithSource = Prisma.SourceVideoGetPayload<{ include: { source: true } }>;

export interface AnalysisRunSummary {
  // FREE local filtering (acquisition + source-cleanliness scan) — governed
  // by `freeLocalFilterBatchSize`, NEVER by maxQuickScansPerRun. Zero
  // Anthropic cost regardless of how large this batch is.
  videosScanned: number; // candidates that went through the free local stage this tick
  dirtyLeads: number; // newly classified dirty_lead this tick
  waitingForAi: number; // newly became waiting_for_ai (clean, ready, parked) this tick

  // PAID Anthropic processing — governed by maxQuickScansPerRun /
  // maxDetailedAnalysesPerRun / the AI budget gate. Only runs at all when
  // Paid AI Analysis is on and a real ANTHROPIC_API_KEY is configured.
  //
  // anthropicRequestsAttempted/Completed/quickScans/detailedAnalyses/
  // actualCostUsd are all derived AFTER the batch by querying the
  // persisted `ApiUsage` rows for this tick's runToken (see
  // summarizePersistedUsage below) — never accumulated purely in-memory. This
  // exists because of a real production incident where a worker tick's
  // own log claimed `anthropicCalls: 0` while the dashboard (reading the
  // same ApiUsage table) showed 2 new calls: the in-memory counter was
  // counting CANDIDATES, not requests, and could drift from what was
  // actually persisted. Deriving from ApiUsage makes that class of bug
  // structurally impossible — the summary can never claim fewer completed
  // requests than rows that actually exist for this run.
  anthropicRequestsAttempted: number; // reservation attempts this tick, including budget-blocked ones (in-memory — blocked attempts leave no ApiUsage row)
  anthropicRequestsCompleted: number; // COUNT(*) of ApiUsage rows for this runToken — real, billed Anthropic calls
  quickScans: number; // of those, operation = "quick_scan"
  detailedAnalyses: number; // of those, operation = "detailed_analysis"
  paidCandidatesProcessed: number; // COUNT(DISTINCT sourceVideoId) among this run's ApiUsage rows
  momentsFound: number;
  actualCostUsd: number; // SUM(costUsd) of this run's ApiUsage rows — the real, reconciled spend

  /** True if this call did no work because a previous analysis batch was still running (DB-backed lock — see database/jobLock.ts). */
  skippedAlreadyRunning?: boolean;
}

const ANALYSIS_LOCK_NAME = "analysis";
// A full local-filtering batch (up to freeLocalFilterBatchSize acquisitions
// + cleanliness scans) plus a small paid batch should comfortably finish
// well under this; a generous ceiling before a lock is treated as
// abandoned by a crashed holder.
const ANALYSIS_STALE_AFTER_MS = 30 * 60 * 1000;

// How many times one candidate may enter the PAID batch
// (runPaidAnalysisOnVideo) before it's parked as a terminal `ai_failed`
// instead of being retried again — bounds worst-case repeated acquisition
// + Anthropic-attempt cycles for one stubborn candidate (e.g. one that
// keeps hitting the budget gate, or whose analysis keeps throwing). See
// `SourceVideo.paidAnalysisAttempts`'s schema comment.
export const MAX_PAID_ANALYSIS_ATTEMPTS = 3;

function emptySummary(): AnalysisRunSummary {
  return {
    videosScanned: 0,
    dirtyLeads: 0,
    waitingForAi: 0,
    anthropicRequestsAttempted: 0,
    anthropicRequestsCompleted: 0,
    quickScans: 0,
    detailedAnalyses: 0,
    paidCandidatesProcessed: 0,
    momentsFound: 0,
    actualCostUsd: 0,
  };
}

/**
 * FREE local filtering (acquisition + src/analysis/sourceCleanliness.ts,
 * batched up to `freeLocalFilterBatchSize`, zero Anthropic cost, always
 * runs) → PAID Anthropic processing (batched up to `maxQuickScansPerRun`,
 * only when Paid AI Analysis is on). These are two independent batch
 * sizes on purpose — see README's "Cost control" section. Category
 * prefiltering (src/discovery/categoryPrefilter.ts) already ran once at
 * discovery time (src/discovery/runDiscovery.ts), not here.
 */
export async function runAnalysis(): Promise<AnalysisRunSummary> {
  // Default analysis_concurrency = 1, enforced via a DB-backed mutex (not
  // just the worker's own in-memory guard, which only protects against a
  // single process's own overlapping ticks — this also protects against
  // the web service's manual "Run discovery now" background continuation
  // racing the worker's next tick).
  const lock = await tryAcquireLock(ANALYSIS_LOCK_NAME, ANALYSIS_STALE_AFTER_MS);
  if (!lock.acquired) {
    return { ...emptySummary(), skippedAlreadyRunning: true };
  }

  try {
    return await runAnalysisLocked();
  } finally {
    await releaseLock(ANALYSIS_LOCK_NAME, lock.token!);
  }
}

async function runAnalysisLocked(): Promise<AnalysisRunSummary> {
  const settings = await getSettings();
  const now = new Date();

  const local = await runFreeLocalFilteringBatch(settings.freeLocalFilterBatchSize, settings.minSourceCleanlinessScore, now);

  // Deliberately NOT gated on `local.environmentBroken`. The free batch and
  // the paid batch query, acquire, and process entirely disjoint sets of
  // candidates (discovered/queued_for_scan/source_access_blocked vs.
  // waiting_for_ai) — a broken yt-dlp/ffmpeg environment discovered while
  // processing ONE free-batch candidate says nothing about whether the
  // *paid* batch's own candidates can be acquired, and the paid batch
  // already does its own environment-broken detection (via its own
  // acquireSourceFile call inside runPaidAnalysisOnVideo) and stops itself
  // early if that also turns out to be broken. Gating the paid batch's
  // invocation on the free batch's outcome was a real production bug: a
  // worker tick logged `[worker] paid Anthropic processing done` with every
  // field at 0 while 55 real waiting_for_ai candidates existed, because
  // this ternary skipped runPaidAnthropicBatch entirely (its SELECT never
  // ran) the moment the free batch's single candidate that tick hit
  // binary_missing/ffmpeg_missing. See README's "A third production
  // incident" for the full story.
  const aiAvailable = settings.paidAiAnalysisEnabled && Boolean(env.anthropicApiKey);
  const paid = aiAvailable
    ? await runPaidAnthropicBatch(settings.maxQuickScansPerRun, settings.maxDetailedAnalysesPerRun, settings.minViralScore, now)
    : {
        anthropicRequestsAttempted: 0,
        anthropicRequestsCompleted: 0,
        quickScans: 0,
        detailedAnalyses: 0,
        paidCandidatesProcessed: 0,
        momentsFound: 0,
        actualCostUsd: 0,
      };

  console.log("[worker] local filtering done", {
    processed: local.videosScanned,
    dirtyLeads: local.dirtyLeads,
    waitingForAi: local.waitingForAi,
    accessBlocked: local.accessBlockedCount,
    environmentBroken: local.environmentBroken,
  });
  if (aiAvailable) {
    console.log("[worker] paid Anthropic processing done", {
      anthropicRequestsAttempted: paid.anthropicRequestsAttempted,
      anthropicRequestsCompleted: paid.anthropicRequestsCompleted,
      quickScans: paid.quickScans,
      detailedAnalyses: paid.detailedAnalyses,
      paidCandidatesProcessed: paid.paidCandidatesProcessed,
      momentsFound: paid.momentsFound,
      actualCostUsd: Number(paid.actualCostUsd.toFixed(4)),
    });
  } else {
    console.log("[worker] paid Anthropic processing skipped (Paid AI Analysis is OFF or ANTHROPIC_API_KEY is unset)", {
      anthropicRequestsCompleted: 0,
    });
  }

  return {
    videosScanned: local.videosScanned,
    dirtyLeads: local.dirtyLeads,
    waitingForAi: local.waitingForAi,
    anthropicRequestsAttempted: paid.anthropicRequestsAttempted,
    anthropicRequestsCompleted: paid.anthropicRequestsCompleted,
    quickScans: paid.quickScans,
    detailedAnalyses: paid.detailedAnalyses,
    paidCandidatesProcessed: paid.paidCandidatesProcessed,
    momentsFound: paid.momentsFound,
    actualCostUsd: paid.actualCostUsd,
  };
}

// ---------------------------------------------------------------------------
// FREE local filtering batch — acquisition + source-cleanliness scan only.
// Never calls Anthropic. Runs regardless of Paid AI Analysis / API key, so
// the backlog keeps draining into dirty_lead/waiting_for_ai even while
// paid analysis stays off — see README's "Cost control" section.
// ---------------------------------------------------------------------------

interface LocalFilteringBatchResult {
  videosScanned: number;
  dirtyLeads: number;
  waitingForAi: number;
  accessBlockedCount: number;
  environmentBroken: boolean;
}

async function runFreeLocalFilteringBatch(
  batchSize: number,
  minCleanlinessScore: number,
  now: Date,
): Promise<LocalFilteringBatchResult> {
  const candidates = await prisma.sourceVideo.findMany({
    where: {
      AND: [{ status: { in: ["discovered", "queued_for_scan", "source_access_blocked"] } }, acquisitionEligible(now)],
    },
    orderBy: { preliminaryScore: "desc" },
    take: batchSize,
    include: { source: true },
  });

  let dirtyLeads = 0;
  let waitingForAi = 0;
  let accessBlockedCount = 0;
  let environmentBroken = false;

  // Sequential by construction (never Promise.all) — bounded, predictable
  // resource usage (one ffmpeg/yt-dlp invocation at a time) rather than
  // spawning up to `batchSize` concurrent processes; see
  // acquisitionThrottle.ts for the pacing this also relies on.
  const circuitBreaker = new AcquisitionCircuitBreaker();

  for (const video of candidates) {
    const result = await runLocalFilterOnVideo(video, minCleanlinessScore);
    if (result.wasDirtyLead) dirtyLeads++;
    if (result.becameWaitingForAi) waitingForAi++;

    if (result.environmentBroken) {
      environmentBroken = true;
      await logError(
        "analysis",
        "Stopping local filtering early: the media-acquisition environment (yt-dlp/ffmpeg) is unusable, so the remaining candidates would fail identically",
      );
      break;
    }

    if (!result.wasAccessBlocked) {
      circuitBreaker.recordNotBlocked();
      continue;
    }
    accessBlockedCount++;
    if (circuitBreaker.recordBlocked()) {
      await logError(
        "analysis",
        "Stopping local filtering early: repeated access-blocked results suggest this environment's IP is currently blocked by the source",
      );
      break;
    }
  }

  return { videosScanned: candidates.length, dirtyLeads, waitingForAi, accessBlockedCount, environmentBroken };
}

interface LocalFilterResult {
  wasDirtyLead: boolean;
  becameWaitingForAi: boolean;
  wasAccessBlocked: boolean;
  environmentBroken: boolean;
}

function emptyLocalFilterResult(): LocalFilterResult {
  return { wasDirtyLead: false, becameWaitingForAi: false, wasAccessBlocked: false, environmentBroken: false };
}

async function runLocalFilterOnVideo(
  video: SourceVideoWithSource,
  minCleanlinessScore: number,
): Promise<LocalFilterResult> {
  const scratchDir = scratchDirForSourceVideo(video.id);
  await prisma.sourceVideo.update({ where: { id: video.id }, data: { status: "scanning" } });

  try {
    const acquired = await acquireSourceFile(video, scratchDir);
    if (!acquired.ok) {
      return {
        ...emptyLocalFilterResult(),
        wasAccessBlocked: acquired.wasAccessBlocked,
        environmentBroken: acquired.environmentBroken,
      };
    }

    const info = await probeVideo(acquired.filePath);

    // LOCAL SOURCE CLEANLINESS SCAN — zero Anthropic cost. Persisted
    // regardless of outcome so it's visible on the dashboard either way.
    const cleanliness = await scanSourceCleanliness(acquired.filePath, scratchDir, info);
    const cleanlinessData = {
      sourceCleanlinessScore: cleanliness.score,
      hasLargeCaptions: cleanliness.hasLargeCaptions,
      hasArrows: cleanliness.hasArrows,
      hasCircles: cleanliness.hasCircles,
      hasSplitScreen: cleanliness.hasSplitScreen,
      hasLargeGraphicOverlays: cleanliness.hasLargeGraphicOverlays,
      likelyRepost: cleanliness.likelyRepost,
      cleanlinessReason: cleanliness.reason,
    };

    if (cleanliness.score < minCleanlinessScore) {
      // DIRTY SOURCE → DIRTY_LEAD, never sent to Anthropic. Kept as a lead
      // with suggested clean-source searches rather than just discarded.
      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: {
          ...cleanlinessData,
          status: "dirty_lead",
          cleanSourceQueries: suggestCleanSourceQueries(video.title),
          errorMessage: null,
        },
      });
      return { ...emptyLocalFilterResult(), wasDirtyLead: true };
    }

    // Clean and relevant (category already confirmed at discovery time) —
    // parked as waiting_for_ai regardless of whether Paid AI Analysis is
    // currently on. The paid batch below picks it up from here when (and
    // only when) AI is available; otherwise it just stays queued.
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { ...cleanlinessData, status: "waiting_for_ai", errorMessage: null },
    });
    return { ...emptyLocalFilterResult(), becameWaitingForAi: true };
  } catch (err) {
    await logError("quick_scan", `Local filtering failed for source video ${video.id}`, err, {
      sourceVideoId: video.id,
    });
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { status: "error", errorMessage: err instanceof Error ? err.message : String(err) },
    });
    return emptyLocalFilterResult();
  } finally {
    await cleanupScratchDir(scratchDir);
  }
}

// ---------------------------------------------------------------------------
// PAID Anthropic batch — only ever called when Paid AI Analysis is on and a
// real ANTHROPIC_API_KEY is configured. Bounded by maxQuickScansPerRun,
// completely independent of the free batch size above. The hard budget
// gate (src/ai/budget.ts::reserveAiBudget) is still the true enforcement
// point — this cap is a courtesy limit on top of it, not a replacement.
// ---------------------------------------------------------------------------

interface PaidAnthropicBatchResult {
  anthropicRequestsAttempted: number;
  anthropicRequestsCompleted: number;
  quickScans: number;
  detailedAnalyses: number;
  paidCandidatesProcessed: number;
  momentsFound: number;
  actualCostUsd: number;
}

async function runPaidAnthropicBatch(
  maxQuickScans: number,
  maxDetailedAnalyses: number,
  minViralScore: number,
  now: Date,
): Promise<PaidAnthropicBatchResult> {
  const eligibleWhere: Prisma.SourceVideoWhereInput = {
    AND: [{ status: "waiting_for_ai" }, { paidAnalysisAttempts: { lt: MAX_PAID_ANALYSIS_ATTEMPTS } }, acquisitionEligible(now)],
  };

  // Production-safe queue diagnostics, logged BEFORE selection so a tick
  // that finds 0 candidates is never silently indistinguishable from one
  // where the queue was genuinely empty. `waitingForAiTotal` is
  // deliberately computed the exact same way
  // (`prisma.sourceVideo.count({ where: { status: "waiting_for_ai" } })`)
  // as the Settings/stats dashboard's "Clean candidates / waiting for AI"
  // tile, so the two numbers are directly comparable in the logs — this is
  // the fix for a real incident where the dashboard showed 55 waiting_for_ai
  // rows but the worker log showed 0 selected with no way to tell why.
  const [waitingForAiTotal, blockedByAttemptCap, eligibleForPaidSelection] = await Promise.all([
    prisma.sourceVideo.count({ where: { status: "waiting_for_ai" } }),
    prisma.sourceVideo.count({ where: { status: "waiting_for_ai", paidAnalysisAttempts: { gte: MAX_PAID_ANALYSIS_ATTEMPTS } } }),
    prisma.sourceVideo.count({ where: eligibleWhere }),
  ]);

  const candidates = await prisma.sourceVideo.findMany({
    where: eligibleWhere,
    orderBy: { preliminaryScore: "desc" },
    take: maxQuickScans,
    include: { source: true },
  });

  console.log("[worker] paid queue status", {
    waitingForAiTotal,
    eligibleForPaidSelection,
    blockedByAttemptCap,
    selected: candidates.length,
  });

  const runToken = generateRunToken();
  let anthropicRequestsAttempted = 0;
  let momentsFound = 0;
  const circuitBreaker = new AcquisitionCircuitBreaker();

  for (const video of candidates) {
    console.log("[worker] paid candidate selected", { sourceVideoId: video.id, status: video.status });
    const result = await runPaidAnalysisOnVideo(video, maxDetailedAnalyses, minViralScore, runToken);
    momentsFound += result.momentsFound;
    anthropicRequestsAttempted += result.requestsAttempted;

    if (result.environmentBroken) {
      await logError(
        "analysis",
        "Stopping paid Anthropic processing early: the media-acquisition environment (yt-dlp/ffmpeg) is unusable",
      );
      break;
    }
    if (result.aiBudgetBlocked) {
      // Every remaining candidate this tick would hit the identical
      // budget/kill-switch/concurrency block — stop rather than retrying
      // pointlessly. They stay waiting_for_ai for the next eligible tick.
      break;
    }
    if (!result.wasAccessBlocked) {
      circuitBreaker.recordNotBlocked();
      continue;
    }
    if (circuitBreaker.recordBlocked()) {
      await logError(
        "analysis",
        "Stopping paid Anthropic processing early: repeated access-blocked results suggest this environment's IP is currently blocked by the source",
      );
      break;
    }
  }

  // Derive the request-level counts from the SAME persisted ApiUsage rows
  // the cost dashboard reads, scoped to this tick's runToken — never from
  // the in-memory accumulation above (which only tracks momentsFound and
  // attempted-including-blocked count; both of those are diagnostic, not
  // the source of truth for "how many real Anthropic calls happened").
  const persisted = await summarizePersistedUsage(runToken);

  return {
    anthropicRequestsAttempted: Math.max(anthropicRequestsAttempted, persisted.completed),
    anthropicRequestsCompleted: persisted.completed,
    quickScans: persisted.quickScans,
    detailedAnalyses: persisted.detailedAnalyses,
    paidCandidatesProcessed: persisted.uniqueSourceVideoIds,
    momentsFound,
    actualCostUsd: persisted.actualCostUsd,
  };
}

export interface PersistedUsageSummary {
  completed: number;
  quickScans: number;
  detailedAnalyses: number;
  uniqueSourceVideoIds: number;
  actualCostUsd: number;
}

/**
 * Reads back this run's actual Anthropic usage from `ApiUsage` — the single
 * source of truth a worker summary must never contradict (see
 * AnalysisRunSummary's doc comment). Exported (not just internal) so tests
 * can seed real ApiUsage rows and verify this derivation directly, without
 * needing a real Anthropic call to produce them.
 */
export async function summarizePersistedUsage(runToken: string): Promise<PersistedUsageSummary> {
  const rows = await prisma.apiUsage.findMany({
    where: { provider: "anthropic", runToken },
    select: { operation: true, sourceVideoId: true, costUsd: true },
  });

  const uniqueSourceVideoIds = new Set(rows.map((r) => r.sourceVideoId).filter((id): id is string => Boolean(id)));

  return {
    completed: rows.length,
    quickScans: rows.filter((r) => r.operation === "quick_scan").length,
    detailedAnalyses: rows.filter((r) => r.operation === "detailed_analysis").length,
    uniqueSourceVideoIds: uniqueSourceVideoIds.size,
    actualCostUsd: rows.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

interface PaidAnalysisResult {
  momentsFound: number;
  /** Reservation attempts made for this candidate this call (quick scan + however many detailed-analysis windows were tried), whether or not each was budget-blocked. Diagnostic only — anthropicRequestsCompleted is what's authoritative. */
  requestsAttempted: number;
  aiBudgetBlocked: boolean;
  wasAccessBlocked: boolean;
  environmentBroken: boolean;
}

function emptyPaidResult(): PaidAnalysisResult {
  return { momentsFound: 0, requestsAttempted: 0, aiBudgetBlocked: false, wasAccessBlocked: false, environmentBroken: false };
}

async function runPaidAnalysisOnVideo(
  video: SourceVideoWithSource,
  maxDetailedAnalyses: number,
  minViralScore: number,
  runToken: string,
): Promise<PaidAnalysisResult> {
  const scratchDir = scratchDirForSourceVideo(video.id);
  let momentsFound = 0;
  let requestsAttempted = 0;
  // Incremented unconditionally as this candidate enters the paid batch —
  // see MAX_PAID_ANALYSIS_ATTEMPTS / SourceVideo.paidAnalysisAttempts's
  // schema comment. Distinct from `ai_processing` being merely a status:
  // this is what makes a stubborn candidate (repeatedly budget-blocked,
  // repeatedly erroring) eventually stop being re-selected, rather than
  // silently retrying forever every worker tick.
  const attemptsSoFar = video.paidAnalysisAttempts + 1;
  await prisma.sourceVideo.update({
    where: { id: video.id },
    data: { status: "ai_processing", paidAnalysisAttempts: attemptsSoFar },
  });
  const attemptsExhausted = attemptsSoFar >= MAX_PAID_ANALYSIS_ATTEMPTS;

  try {
    // Re-acquire: the free stage's scratch file was already cleaned up
    // after it computed and persisted the cleanliness score (redoing an
    // acquisition is bandwidth-only, never Anthropic cost, and keeps this
    // step resumable the same way the rest of the pipeline already is —
    // see README's "Resumability" notes). Cleanliness itself is NOT
    // re-scanned; the persisted score from the free stage is reused as-is.
    const acquired = await acquireSourceFile(video, scratchDir);
    if (!acquired.ok) {
      // Acquisition failing here moves the video out of waiting_for_ai
      // (into error/source_access_blocked, via acquireSourceFile's own DB
      // update) — the free batch will re-acquire and re-scan it on a
      // later tick, which is fine since that's free/local work.
      return {
        ...emptyPaidResult(),
        wasAccessBlocked: acquired.wasAccessBlocked,
        environmentBroken: acquired.environmentBroken,
      };
    }

    const info = await probeVideo(acquired.filePath);

    const quickScanJob = await prisma.analysisJob.create({
      data: { sourceVideoId: video.id, type: "quick_scan", status: "running", startedAt: new Date() },
    });

    let windows;
    let quickScanCost;
    try {
      requestsAttempted++;
      const result = await runQuickScan(acquired.filePath, scratchDir, info, video.category, {
        runToken,
        sourceVideoId: video.id,
        analysisJobId: quickScanJob.id,
      });
      windows = result.windows;
      quickScanCost = result.costUsd;
    } catch (err) {
      if (err instanceof AiBudgetBlockedError) {
        await prisma.analysisJob.update({
          where: { id: quickScanJob.id },
          data: { status: "failed", finishedAt: new Date(), errorMessage: err.message },
        });
        if (attemptsExhausted) {
          // Budget-blocked MAX_PAID_ANALYSIS_ATTEMPTS times in a row — no
          // Anthropic cost was ever incurred for this candidate, but
          // leaving it in waiting_for_ai would mean it keeps getting
          // re-selected (and re-acquired) every tick indefinitely. Park it
          // as a terminal, clearly-labeled failure instead of silently
          // stranding it outside every query this batch uses.
          await prisma.sourceVideo.update({
            where: { id: video.id },
            data: {
              status: "ai_failed",
              errorMessage: `Blocked by the AI budget/availability gate on all ${attemptsSoFar} paid-analysis attempts: ${err.message}`,
            },
          });
        } else {
          // Back to waiting_for_ai — it just didn't get its turn (or the
          // budget ran out) this tick, not a failure.
          await prisma.sourceVideo.update({ where: { id: video.id }, data: { status: "waiting_for_ai" } });
        }
        return { ...emptyPaidResult(), requestsAttempted, aiBudgetBlocked: true };
      }
      throw err;
    }

    await prisma.analysisJob.update({
      where: { id: quickScanJob.id },
      data: { status: "succeeded", finishedAt: new Date(), costUsd: quickScanCost },
    });

    if (windows.length === 0) {
      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: { status: "ai_rejected_quick", accessFailureCount: 0, nextRetryAt: null },
      });
      return { ...emptyPaidResult(), requestsAttempted };
    }

    let detailedAnalysesUsed = 0;
    let blockedMidLoop = false;
    let hasQualifyingMoment = false;
    for (const window of windows) {
      if (detailedAnalysesUsed >= maxDetailedAnalyses) break;
      detailedAnalysesUsed++;

      const candidateWindow = await prisma.candidateWindow.create({
        data: {
          sourceVideoId: video.id,
          startSeconds: window.startSeconds,
          endSeconds: window.endSeconds,
          reason: window.reason,
        },
      });

      const detailedJob = await prisma.analysisJob.create({
        data: { sourceVideoId: video.id, type: "detailed_analysis", status: "running", startedAt: new Date() },
      });

      try {
        requestsAttempted++;
        const { moments, costUsd } = await runDetailedAnalysis(acquired.filePath, scratchDir, info, video.category, window, {
          runToken,
          sourceVideoId: video.id,
          analysisJobId: detailedJob.id,
        });
        await prisma.analysisJob.update({
          where: { id: detailedJob.id },
          data: { status: "succeeded", finishedAt: new Date(), costUsd },
        });
        await prisma.candidateWindow.update({
          where: { id: candidateWindow.id },
          data: { analyzed: true },
        });

        for (const moment of moments) {
          const viralScore = computeViralScore(moment.scores);
          await prisma.detectedMoment.create({
            data: {
              sourceVideoId: video.id,
              candidateWindowId: candidateWindow.id,
              category: moment.category,
              title: moment.title,
              description: moment.description,
              reason: moment.reason,
              startSeconds: moment.start_seconds,
              peakSeconds: moment.peak_seconds,
              endSeconds: moment.end_seconds,
              scores: moment.scores,
              viralScore,
              confidence: moment.confidence,
              trackedKeyframes: moment.tracked_keyframes.map((k) => ({
                timeSeconds: k.time_seconds,
                primary: k.primary,
                secondary: k.secondary,
              })),
            },
          });
          momentsFound++;
          if (viralScore >= minViralScore) hasQualifyingMoment = true;
        }
      } catch (err) {
        if (err instanceof AiBudgetBlockedError) {
          await prisma.analysisJob.update({
            where: { id: detailedJob.id },
            data: { status: "failed", finishedAt: new Date(), errorMessage: err.message },
          });
          // Quick scan already ran (and was paid for); keep whatever
          // moments were already found rather than discarding this video —
          // just stop trying further windows this attempt.
          blockedMidLoop = true;
          break;
        }
        await prisma.analysisJob.update({
          where: { id: detailedJob.id },
          data: {
            status: "failed",
            finishedAt: new Date(),
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        await logError("detailed_analysis", `Failed for source video ${video.id}`, err, {
          sourceVideoId: video.id,
          window,
        });
      }
    }

    // Precisely three distinguishable outcomes once quick scan found at
    // least one window and detailed analysis ran: a real, qualifying
    // moment ("scanned" — eligible for render/Top Clips); moments were
    // found but none cleared minViralScore ("ai_rejected_below_score" — a
    // real result, not a failure); or detailed analysis ran but produced
    // zero DetectedMoment rows at all ("ai_rejected_detailed"). Never
    // collapse these back into one bucket — that's exactly what made
    // rejected candidates look like they'd silently vanished.
    const finalStatus = hasQualifyingMoment ? "scanned" : momentsFound > 0 ? "ai_rejected_below_score" : "ai_rejected_detailed";
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: {
        status: finalStatus,
        accessFailureCount: 0,
        nextRetryAt: null,
      },
    });

    return { ...emptyPaidResult(), momentsFound, requestsAttempted, aiBudgetBlocked: blockedMidLoop };
  } catch (err) {
    await logError("quick_scan", `Paid analysis failed for source video ${video.id}`, err, {
      sourceVideoId: video.id,
    });
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { status: "ai_failed", errorMessage: err instanceof Error ? err.message : String(err) },
    });
    return { ...emptyPaidResult(), requestsAttempted };
  } finally {
    await cleanupScratchDir(scratchDir);
  }
}

// ---------------------------------------------------------------------------
// Shared acquisition helper — identical error handling/classification used
// by both the free and paid stages above.
// ---------------------------------------------------------------------------

type AcquireOutcome = { ok: true; filePath: string } | { ok: false; environmentBroken: boolean; wasAccessBlocked: boolean };

async function acquireSourceFile(video: SourceVideoWithSource, scratchDir: string): Promise<AcquireOutcome> {
  const source = getSource(video.source.name);
  const availability = await source.getVideoSource(video.sourceVideoId);
  if (!availability.downloadable) {
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { status: "error", errorMessage: `Not downloadable: ${availability.reason ?? "unknown"}` },
    });
    return { ok: false, environmentBroken: false, wasAccessBlocked: false };
  }

  try {
    const filePath = await acquireVideo(availability, scratchDir);
    return { ok: true, filePath };
  } catch (err) {
    if (!(err instanceof AcquisitionError)) throw err;
    const { classification } = err;

    if (classification.kind === "binary_missing" || classification.kind === "ffmpeg_missing") {
      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: { status: "error", errorMessage: classification.message },
      });
      await logError("quick_scan", `Media-acquisition environment problem for ${video.id}`, err, {
        sourceVideoId: video.id,
      });
      return { ok: false, environmentBroken: true, wasAccessBlocked: false };
    }

    if (classification.isAccessBlocked) {
      await markSourceVideoAccessBlocked(video.id, classification.message);
      return { ok: false, environmentBroken: false, wasAccessBlocked: true };
    }

    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { status: "error", errorMessage: classification.message },
    });
    await logError("quick_scan", `Media acquisition failed for ${video.id}`, err, { sourceVideoId: video.id });
    return { ok: false, environmentBroken: false, wasAccessBlocked: false };
  }
}
