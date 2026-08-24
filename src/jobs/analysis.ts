import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { acquisitionEligible, markSourceVideoAccessBlocked } from "@/database/acquisitionCooldown";
import { isWithinDailyBudget } from "@/ai/costTracking";
import { getSource } from "@/sources/registry";
import { probeVideo } from "@/video/ffmpeg";
import { acquireVideo } from "@/video/acquire";
import { AcquisitionError } from "@/video/acquisitionErrors";
import { AcquisitionCircuitBreaker } from "@/video/acquisitionThrottle";
import { scratchDirForSourceVideo, cleanupScratchDir } from "@/lib/scratch";
import { runQuickScan } from "@/analysis/quickScan";
import { runDetailedAnalysis } from "@/analysis/detailedAnalysis";
import { computeViralScore } from "@/scoring/viralScore";
import { logError } from "@/lib/errorLog";
import type { Prisma } from "@/generated/prisma";

type SourceVideoWithSource = Prisma.SourceVideoGetPayload<{ include: { source: true } }>;

export interface AnalysisRunSummary {
  videosScanned: number;
  momentsFound: number;
}

interface AnalyzeOneVideoResult {
  momentsFound: number;
  /** YouTube (or another yt-dlp source) actively refused this acquisition — 429/bot-check/login-required. */
  wasAccessBlocked: boolean;
  /** yt-dlp/ffmpeg itself isn't usable in this environment — no point trying the next candidate either. */
  environmentBroken: boolean;
}

export async function runAnalysis(): Promise<AnalysisRunSummary> {
  const settings = await getSettings();
  let videosScanned = 0;
  let momentsFound = 0;
  const now = new Date();

  const candidates = await prisma.sourceVideo.findMany({
    where: {
      AND: [
        { status: { in: ["discovered", "queued_for_scan", "source_access_blocked"] } },
        acquisitionEligible(now),
      ],
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
    if (!(await isWithinDailyBudget())) break;

    videosScanned++;
    const result = await analyzeOneVideo(video, settings.maxDetailedAnalysesPerRun);
    momentsFound += result.momentsFound;

    if (result.environmentBroken) {
      await logError(
        "analysis",
        "Stopping this analysis run early: the media-acquisition environment (yt-dlp/ffmpeg) is unusable, so the remaining candidates would fail identically",
      );
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

  return { videosScanned, momentsFound };
}

async function analyzeOneVideo(
  video: SourceVideoWithSource,
  maxDetailedAnalyses: number,
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
      return { momentsFound: 0, wasAccessBlocked: false, environmentBroken: false };
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
        return { momentsFound: 0, wasAccessBlocked: false, environmentBroken: true };
      }

      if (classification.isAccessBlocked) {
        await markSourceVideoAccessBlocked(video.id, classification.message);
        return { momentsFound: 0, wasAccessBlocked: true, environmentBroken: false };
      }

      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: { status: "error", errorMessage: classification.message },
      });
      await logError("quick_scan", `Media acquisition failed for ${video.id}`, err, { sourceVideoId: video.id });
      return { momentsFound: 0, wasAccessBlocked: false, environmentBroken: false };
    }

    const info = await probeVideo(filePath);

    const quickScanJob = await prisma.analysisJob.create({
      data: { sourceVideoId: video.id, type: "quick_scan", status: "running", startedAt: new Date() },
    });
    const { windows, costUsd: quickScanCost } = await runQuickScan(
      filePath,
      scratchDir,
      info,
      video.category,
    );
    await prisma.analysisJob.update({
      where: { id: quickScanJob.id },
      data: { status: "succeeded", finishedAt: new Date(), costUsd: quickScanCost },
    });

    if (windows.length === 0) {
      await prisma.sourceVideo.update({
        where: { id: video.id },
        data: { status: "no_candidates", accessFailureCount: 0, nextRetryAt: null },
      });
      return { momentsFound: 0, wasAccessBlocked: false, environmentBroken: false };
    }

    let detailedAnalysesUsed = 0;
    for (const window of windows) {
      if (detailedAnalysesUsed >= maxDetailedAnalyses) break;
      if (!(await isWithinDailyBudget())) break;
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
        const { moments, costUsd } = await runDetailedAnalysis(
          filePath,
          scratchDir,
          info,
          video.category,
          window,
        );
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
        status: momentsFound > 0 ? "scanned" : "no_candidates",
        accessFailureCount: 0,
        nextRetryAt: null,
      },
    });
  } catch (err) {
    await logError("quick_scan", `Analysis failed for source video ${video.id}`, err, {
      sourceVideoId: video.id,
    });
    await prisma.sourceVideo.update({
      where: { id: video.id },
      data: { status: "error", errorMessage: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    await cleanupScratchDir(scratchDir);
  }

  return { momentsFound, wasAccessBlocked: false, environmentBroken: false };
}
