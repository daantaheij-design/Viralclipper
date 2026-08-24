import path from "node:path";
import { copyFile } from "node:fs/promises";
import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { getSource } from "@/sources/registry";
import { probeVideo } from "@/video/ffmpeg";
import { downloadVideo } from "@/video/ytdlp";
import { computeSmartCropKeyframes } from "@/video/smartCrop";
import { claudeVisionTracker } from "@/video/objectTracking";
import { renderVerticalClip } from "@/video/renderVertical";
import { scratchDirForRender, cleanupScratchDir } from "@/lib/scratch";
import { absolutePathFor, ensureStorageDirFor, fileSizeBytes, storageKeyFor } from "@/storage";
import { logError } from "@/lib/errorLog";
import type { Prisma } from "@/generated/prisma";

type MomentWithVideo = Prisma.DetectedMomentGetPayload<{
  include: { sourceVideo: { include: { source: true } } };
}>;

export interface ProcessingRunSummary {
  rendered: number;
  failed: number;
}

export async function runProcessing(): Promise<ProcessingRunSummary> {
  const settings = await getSettings();

  const moments = await prisma.detectedMoment.findMany({
    where: {
      viralScore: { gte: settings.minViralScore },
      status: "moment_found",
    },
    orderBy: { viralScore: "desc" },
    take: settings.maxRendersPerRun,
    include: { sourceVideo: { include: { source: true } } },
  });

  let rendered = 0;
  let failed = 0;

  for (const moment of moments) {
    const ok = await renderOneMoment(moment);
    if (ok) rendered++;
    else failed++;
  }

  return { rendered, failed };
}

async function renderOneMoment(moment: MomentWithVideo): Promise<boolean> {
  const scratchDir = scratchDirForRender(moment.id);

  await prisma.detectedMoment.update({ where: { id: moment.id }, data: { status: "tiktok_processing" } });
  const tikTokVersion = await prisma.tikTokVersion.upsert({
    where: { momentId: moment.id },
    create: { momentId: moment.id, status: "processing" },
    update: { status: "processing", errorMessage: null },
  });

  try {
    const source = getSource(moment.sourceVideo.source.name);
    const availability = await source.getVideoSource(moment.sourceVideo.sourceVideoId);
    if (!availability.downloadable) {
      await markUnavailable(moment.id, tikTokVersion.id, availability.reason);
      return false;
    }

    const filePath = await downloadVideo(availability.url, scratchDir);
    const info = await probeVideo(filePath);

    const tracked = claudeVisionTracker.track({ rawKeyframes: moment.trackedKeyframes });
    // trackedKeyframes are in absolute source-video seconds; smart crop wants
    // them clip-relative.
    const relativeTracked = tracked.map((k) => ({
      ...k,
      timeSeconds: k.timeSeconds - moment.startSeconds,
    }));
    const durationSeconds = moment.endSeconds - moment.startSeconds;
    const cropKeyframes = computeSmartCropKeyframes(info, durationSeconds, relativeTracked);

    const renderedPath = path.join(scratchDir, "output.mp4");
    await renderVerticalClip({
      sourceFilePath: filePath,
      outputFilePath: renderedPath,
      source: info,
      startSeconds: moment.startSeconds,
      endSeconds: moment.endSeconds,
      cropKeyframes,
    });

    const storageKey = storageKeyFor(moment.id);
    await ensureStorageDirFor(storageKey);
    await copyFile(renderedPath, absolutePathFor(storageKey));
    const sizeBytes = await fileSizeBytes(storageKey);

    await prisma.tikTokVersion.update({
      where: { id: tikTokVersion.id },
      data: {
        status: "ready",
        storageKey,
        durationSeconds,
        fps: info.fps,
        fileSizeBytes: sizeBytes,
        cropKeyframes: cropKeyframes as unknown as Prisma.InputJsonValue,
        renderedAt: new Date(),
        errorMessage: null,
      },
    });
    await prisma.detectedMoment.update({ where: { id: moment.id }, data: { status: "ready" } });
    return true;
  } catch (err) {
    await logError("render", `Render failed for moment ${moment.id}`, err, { momentId: moment.id });
    await prisma.tikTokVersion.update({
      where: { id: tikTokVersion.id },
      data: { status: "failed", errorMessage: err instanceof Error ? err.message : String(err) },
    });
    await prisma.detectedMoment.update({ where: { id: moment.id }, data: { status: "error" } });
    return false;
  } finally {
    await cleanupScratchDir(scratchDir);
  }
}

async function markUnavailable(momentId: string, tikTokVersionId: string, reason?: string): Promise<void> {
  await prisma.tikTokVersion.update({
    where: { id: tikTokVersionId },
    data: { status: "unavailable", errorMessage: reason ?? "Source no longer downloadable" },
  });
  await prisma.detectedMoment.update({ where: { id: momentId }, data: { status: "ready" } });
}
