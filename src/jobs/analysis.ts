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
import type { Prisma, VideoProcessingStatus } from "@/generated/prisma";

type SourceVideoWithSource = Prisma.SourceVideoGetPayload<{ include: { source: true } }>;

export interface AnalysisRunSummary {
  videosScanned: number;
  momentsFound: number;
  dirtyLeads: number;
  waitingForAi: number;
  /** True if this call did no work because a previous analysis batch was still running (DB-backed lock — see database/jobLock.ts). */
  skippedAlreadyRunning?: boolean;
}

const ANALYSIS_LOCK_NAME = "analysis";
// A single video's acquire+scan+quick-scan+detailed-analysis pass should
// take at most a few minutes; this is a generous ceiling before a lock is
// treated as abandoned by a crashed holder.
const ANALYSIS_STALE_AFTER_MS = 30 * 60 * 1000;

interface AnalyzeOneVideoResult {
  momentsFound: number;
  /** YouTube (or another yt-dlp source) actively refused this acquisition — 429/bot-check/login-required. */
  wasAccessBlocked: boolean;
  /** yt-dlp/ffmpeg itself isn't usable in this environment — no point trying the next candidate either. */
  environmentBroken: boolean;
  /** Local cleanliness scan failed the gate — never reached Anthropic. */
  wasDirtyLead: boolean;
  /** Every free/local gate passed but the AI budget gate blocked the Anthropic call — see src/ai/budget.ts. Every remaining candidate this run would hit the identical block, so the run stops early. */
  aiBudgetBlocked: boolean;
}

/**
 * DISCOVERY → DEDUP → METADATA FILTER → CHEAP CATEGORY PREFILTER (already
 * applied in runDiscovery.ts, before this ever runs) → this file:
 * LOCAL SOURCE CLEANLINESS SCAN → AI BUDGET CHECK → QUICK CLAUDE SCAN →
 * DETAILED CLAUDE ANALYSIS → VIRAL SCORE. Rendering is a separate stage
 * (jobs/processing.ts). See README's "Cost control" section for the full
 * picture — Anthropic is deliberately one of the LAST, most gated steps.
 */
export async function runAnalysis(): Promise<AnalysisRunSummary> {
  // Default analysis_concurrency = 1, enforced via a DB-backed mutex (not
  // just the worker's own in-memory guard, which only protects against a
  // single process's own overlapping ticks — this also protects against
  // the web service's manual "Run discovery now" background continuation
  // racing the worker's next tick).
  const lock = await tryAcquireLock(ANALYSIS_LOCK_NAME, ANALYSIS_STALE_AFTER_MS);
  if (!lock.acquired) {
    return { videosScanned: 0, momentsFound: 0, dirtyLeads: 0, waitingForAi: 0, skippedAlreadyRunning: true };
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
  const runToken = generateRunToken();

  // Only retry `waiting_for_ai` candidates when AI is actually available —
  // otherwise re-acquiring+re-scanning them would just reproduce the exact
  // same block for no reason, and the queue should stay stable (not thrash
  // every 5-minute tick) per the cost-control PR's requirement #11.
  const aiAvailable = settings.paidAiAnalysisEnabled && Boolean(env.anthropicApiKey);
  const eligibleStatuses: VideoProcessingStatus[] = aiAvailable
    ? ["discovered", "queued_for_scan", "source_access_blocked", "waiting_for_ai"]
    : ["discovered", "queued_for_scan", "source_access_blocked"];

  let videosScanned = 0;
  let momentsFound = 0;
  let dirtyLeads = 0;
  let waitingForAi = 0;

  const candidates = await prisma.sourceVideo.findMany({
    where: {
      AND: [{ status: { in: eligibleStatuses } }, acquisitionEligible(now)],
    },
    orderBy: { preliminaryScore: "desc" },
    take: settings.maxQuickScansPerRun,
    include: { source: true },
  });

  // Acquisition is sequential by construction (this loop, one video at a
  // time — never Promise.all) — see the pacing/backoff notes in
  // src/video/acquisitionThrottle.ts.
  const circuitBreaker = new AcquisitionCircuitBreaker();

  for (const video of candidates) {
    videosScanned++;
    const result = await analyzeOneVideo(video, settings.maxDetailedAnalysesPerRun, settings.minSourceCleanlinessScore, runToken);
    momentsFound += result.momentsFound;
    if (result.wasDirtyLead) dirtyLeads++;
    if (result.aiBudgetBlocked) waitingForAi++;

    if (result.environmentBroken) {
      await logError(
        "analysis",
        "Stopping this analysis run early: the media-acquisition environment (yt-dlp/ffmpeg) is unusable, so the remaining candidates would fail identically",
      );
      break;
    }

    if (result.aiBudgetBlocked) {
      // Every remaining candidate this run would hit the exact same
      // budget/kill-switch/concurrency block — stop rather than burning
      // acquisition bandwidth on doomed attempts. Local filtering for
      // *new* (never-scanned) candidates still runs next tick regardless.
      break;
    }

    if (!result.wasAccessBlocked) {
      circuitBreaker.recordNotBlocked();
      continue;
    }
    if (circuitBreaker.recordBlocked()) {
      await logError(
        "analysis",
        "Stopping this analysis run early: repeated access-blocked results suggest this environment's IP is currently blocked by the source",
      );
      break;
    }
  }

  return { videosScanned, momentsFound, dirtyLeads, waitingForAi };
}

async function analyzeOneVideo(
  video: SourceVideoWithSource,
  maxDetailedAnalyses: number,
  minCleanlinessScore: number,
  runToken: string,
): Promise<AnalyzeOneVideoResult> {
  const scratchDir = scratchDirForSourceVideo(video.id);
  let momentsFound = 0;

  await prisma.sourceVideo.update({ where: { id: video.id }, data: { status: "scanning" } });

  try {
    const source = getSource(video.source.name);
    const availability = await source.getVideoSource(video.sourceVideoId);
    if (!availability.downloadable) {
      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: { status: "error", errorMessage: `Not downloadable: ${availability.reason ?? "unknown"}` },
      });
      return emptyResult();
    }

    let filePath: string;
    try {
      filePath = await acquireVideo(availability, scratchDir);
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
        return { ...emptyResult(), environmentBroken: true };
      }

      if (classification.isAccessBlocked) {
        await markSourceVideoAccessBlocked(video.id, classification.message);
        return { ...emptyResult(), wasAccessBlocked: true };
      }

      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: { status: "error", errorMessage: classification.message },
      });
      await logError("quick_scan", `Media acquisition failed for ${video.id}`, err, { sourceVideoId: video.id });
      return emptyResult();
    }

    const info = await probeVideo(filePath);

    // LOCAL SOURCE CLEANLINESS SCAN — zero Anthropic cost. Persisted
    // regardless of outcome so it's visible on the dashboard either way.
    const cleanliness = await scanSourceCleanliness(filePath, scratchDir, info);
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
      return { ...emptyResult(), wasDirtyLead: true };
    }

    // AI BUDGET CHECK happens inside analyzeFrames itself (the single call
    // site) — see src/ai/budget.ts::reserveAiBudget. Catching
    // AiBudgetBlockedError here is what turns a block into WAITING_FOR_AI
    // instead of a repeated failure loop (requirement #11).
    const quickScanJob = await prisma.analysisJob.create({
      data: { sourceVideoId: video.id, type: "quick_scan", status: "running", startedAt: new Date() },
    });

    let windows;
    let quickScanCost;
    try {
      const result = await runQuickScan(filePath, scratchDir, info, video.category, {
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
        await prisma.sourceVideo.update({
          where: { id: video.id },
          data: { ...cleanlinessData, status: "waiting_for_ai", errorMessage: err.message },
        });
        return { ...emptyResult(), aiBudgetBlocked: true };
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
        data: { ...cleanlinessData, status: "no_candidates", accessFailureCount: 0, nextRetryAt: null },
      });
      return emptyResult();
    }

    let detailedAnalysesUsed = 0;
    let blockedMidLoop = false;
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
        const { moments, costUsd } = await runDetailedAnalysis(filePath, scratchDir, info, video.category, window, {
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
              viralScore: computeViralScore(moment.scores),
              confidence: moment.confidence,
              trackedKeyframes: moment.tracked_keyframes.map((k) => ({
                timeSeconds: k.time_seconds,
                primary: k.primary,
                secondary: k.secondary,
              })),
            },
          });
          momentsFound++;
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

    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: {
        ...cleanlinessData,
        status: momentsFound > 0 ? "scanned" : "no_candidates",
        accessFailureCount: 0,
        nextRetryAt: null,
      },
    });

    return { ...emptyResult(), momentsFound, aiBudgetBlocked: blockedMidLoop };
  } catch (err) {
    await logError("quick_scan", `Analysis failed for source video ${video.id}`, err, {
      sourceVideoId: video.id,
    });
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { status: "error", errorMessage: err instanceof Error ? err.message : String(err) },
    });
    return emptyResult();
  } finally {
    await cleanupScratchDir(scratchDir);
  }
}

function emptyResult(): AnalyzeOneVideoResult {
  return { momentsFound: 0, wasAccessBlocked: false, environmentBroken: false, wasDirtyLead: false, aiBudgetBlocked: false };
}
