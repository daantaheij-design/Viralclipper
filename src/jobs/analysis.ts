import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { isWithinDailyBudget } from "@/ai/costTracking";
import { getSource } from "@/sources/registry";
import { probeVideo } from "@/video/ffmpeg";
import { downloadVideo } from "@/video/ytdlp";
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

export async function runAnalysis(): Promise<AnalysisRunSummary> {
  const settings = await getSettings();
  let videosScanned = 0;
  let momentsFound = 0;

  const candidates = await prisma.sourceVideo.findMany({
    where: { status: { in: ["discovered", "queued_for_scan"] } },
    orderBy: { preliminaryScore: "desc" },
    take: settings.maxQuickScansPerRun,
    include: { source: true },
  });

  for (const video of candidates) {
    if (!(await isWithinDailyBudget())) break;

    videosScanned++;
    momentsFound += await analyzeOneVideo(video, settings.maxDetailedAnalysesPerRun);
  }

  return { videosScanned, momentsFound };
}

async function analyzeOneVideo(
  video: SourceVideoWithSource,
  maxDetailedAnalyses: number,
): Promise<number> {
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
      return 0;
    }

    const filePath = await downloadVideo(availability.url, scratchDir);
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
      await prisma.sourceVideo.update({ where: { id: video.id }, data: { status: "no_candidates" } });
      return 0;
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
      data: { status: momentsFound > 0 ? "scanned" : "no_candidates" },
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

  return momentsFound;
}
