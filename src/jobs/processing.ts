import path from "node:path";
import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { acquisitionEligible, markSourceVideoAccessBlocked } from "@/database/acquisitionCooldown";
import { getSource } from "@/sources/registry";
import { probeVideo } from "@/video/ffmpeg";
import { acquireVideo } from "@/video/acquire";
import { AcquisitionError } from "@/video/acquisitionErrors";
import { AcquisitionCircuitBreaker } from "@/video/acquisitionThrottle";
import { computeSmartCropKeyframes } from "@/video/smartCrop";
import { claudeVisionTracker } from "@/video/objectTracking";
import { renderVerticalClip } from "@/video/renderVertical";
import { scratchDirForRender, cleanupScratchDir } from "@/lib/scratch";
import { storage, storageKeyFor } from "@/storage";
import { logError } from "@/lib/errorLog";
import type { Prisma } from "@/generated/prisma";

type MomentWithVideo = Prisma.DetectedMomentGetPayload<{
  include: { sourceVideo: { include: { source: true } } };
}>;

export interface ProcessingRunSummary {
  rendered: number;
  failed: number;
}

interface RenderOneMomentResult {
  rendered: boolean;
  wasAccessBlocked: boolean;
  environmentBroken: boolean;
}

export async function runProcessing(): Promise<ProcessingRunSummary> {
  const settings = await getSettings();
  const now = new Date();

  const moments = await prisma.detectedMoment.findMany({
    where: {
      viralScore: { gte: settings.minViralScore },
      status: "moment_found",
      sourceVideo: acquisitionEligible(now),
    },
    orderBy: { viralScore: "desc" },
    take: settings.maxRendersPerRun,
    include: { sourceVideo: { include: { source: true } } },
  });

  let rendered = 0;
  let failed = 0;

  // Sequential, one render at a time — see acquisitionThrottle.ts.
  const circuitBreaker = new AcquisitionCircuitBreaker();

  for (const moment of moments) {
    const result = await renderOneMoment(moment);
    if (result.rendered) rendered++;
    else failed++;

    if (result.environmentBroken) {
      await logError(
        "render",
        "Stopping this render run early: the media-acquisition environment (yt-dlp/ffmpeg) is unusable, so the remaining moments would fail identically",
      );
      break;
    }

    if (!result.wasAccessBlocked) {
      circuitBreaker.recordNotBlocked();
      continue;
    }
    if (circuitBreaker.recordBlocked()) {
      await logError(
        "render",
        "Stopping this render run early: repeated access-blocked results suggest this environment's IP is currently blocked by the source",
      );
      break;
    }
  }

  return { rendered, failed };
}

async function renderOneMoment(moment: MomentWithVideo): Promise<RenderOneMomentResult> {
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
      return { rendered: false, wasAccessBlocked: false, environmentBroken: false };
    }

    let filePath: string;
    try {
      filePath = await acquireVideo(availability, scratchDir);
    } catch (err) {
      if (!(err instanceof AcquisitionError)) throw err;
      const { classification } = err;

      if (classification.kind === "binary_missing" || classification.kind === "ffmpeg_missing") {
        await markFailed(moment.id, tikTokVersion.id, classification.message, "error");
        await logError("render", `Media-acquisition environment problem for moment ${moment.id}`, err, {
          momentId: moment.id,
        });
        return { rendered: false, wasAccessBlocked: false, environmentBroken: true };
      }

      if (classification.isAccessBlocked) {
        await markSourceVideoAccessBlocked(moment.sourceVideo.id, classification.message);
        // Not "error" — this moment is still good, just temporarily
        // unreachable. Back to moment_found so it's retried once the
        // source video's cooldown (see acquisitionCooldown.ts) elapses.
        await markFailed(moment.id, tikTokVersion.id, classification.message, "moment_found");
        return { rendered: false, wasAccessBlocked: true, environmentBroken: false };
      }

      await markFailed(moment.id, tikTokVersion.id, classification.message, "error");
      await logError("render", `Media acquisition failed for moment ${moment.id}`, err, { momentId: moment.id });
      return { rendered: false, wasAccessBlocked: false, environmentBroken: false };
    }

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
    const { sizeBytes } = await storage.upload(storageKey, renderedPath);

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
    return { rendered: true, wasAccessBlocked: false, environmentBroken: false };
  } catch (err) {
    await logError("render", `Render failed for moment ${moment.id}`, err, { momentId: moment.id });
    await markFailed(moment.id, tikTokVersion.id, err instanceof Error ? err.message : String(err), "error");
    return { rendered: false, wasAccessBlocked: false, environmentBroken: false };
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

async function markFailed(
  momentId: string,
  tikTokVersionId: string,
  errorMessage: string,
  momentStatus: "error" | "moment_found",
): Promise<void> {
  await prisma.tikTokVersion.update({
    where: { id: tikTokVersionId },
    data: { status: "failed", errorMessage },
  });
  await prisma.detectedMoment.update({ where: { id: momentId }, data: { status: momentStatus } });
}
