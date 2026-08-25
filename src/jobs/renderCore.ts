import path from "node:path";
import { prisma } from "@/database/client";
import { markSourceVideoAccessBlocked } from "@/database/acquisitionCooldown";
import { getSource } from "@/sources/registry";
import { probeVideo as probeVideoDefault } from "@/video/ffmpeg";
import { acquireVideo as acquireVideoDefault } from "@/video/acquire";
import { AcquisitionError, type AcquisitionErrorKind } from "@/video/acquisitionErrors";
import { computeSmartCropKeyframes } from "@/video/smartCrop";
import { claudeVisionTracker } from "@/video/objectTracking";
import { renderVerticalClip as renderVerticalClipDefault } from "@/video/renderVertical";
import { scratchDirForRender, cleanupScratchDir } from "@/lib/scratch";
import { storage, storageKeyFor } from "@/storage";
import { logError } from "@/lib/errorLog";
import type { Prisma } from "@/generated/prisma";

export type MomentWithVideo = Prisma.DetectedMomentGetPayload<{
  include: { sourceVideo: { include: { source: true } } };
}>;

/**
 * Everything performRenderAndUpload needs to actually touch the outside
 * world (yt-dlp/ffmpeg/storage), pulled out as an interface so tests can
 * substitute fakes for the parts that need real binaries/network — see
 * src/jobs/renderCore.test.ts. The real implementations are the defaults;
 * nothing outside of tests should ever need to pass `deps`.
 */
export interface RenderDependencies {
  acquireVideo: typeof acquireVideoDefault;
  probeVideo: typeof probeVideoDefault;
  renderVerticalClip: typeof renderVerticalClipDefault;
  uploadToStorage: (storageKey: string, localPath: string) => Promise<{ sizeBytes: number }>;
  verifyStorageObjectExists: (storageKey: string) => Promise<boolean>;
}

const defaultDeps: RenderDependencies = {
  acquireVideo: acquireVideoDefault,
  probeVideo: probeVideoDefault,
  renderVerticalClip: renderVerticalClipDefault,
  uploadToStorage: (key, localPath) => storage.upload(key, localPath),
  verifyStorageObjectExists: (key) => storage.exists(key),
};

export type RenderOutcome =
  | "rendered"
  | "source_unavailable"
  | "access_blocked"
  | "environment_broken"
  // Render + upload both reported success, but the object couldn't be
  // confirmed in storage afterward — never trust the upload call alone.
  | "media_missing"
  | "failed";

export interface PerformRenderResult {
  outcome: RenderOutcome;
  message?: string;
  errorKind?: AcquisitionErrorKind;
}

export interface PerformRenderOptions {
  /** Called with a short description at each stage — see jobs/rerender.ts for the `[repair] ...` narrative this drives. */
  onStage?: (stage: string) => void;
  deps?: RenderDependencies;
}

/**
 * Renders one moment's 9:16 clip and uploads it, end to end, using only
 * data already persisted on `moment` (timestamps, category, viral score,
 * tracked subject keyframes) — never calls Claude or re-runs any analysis.
 * This is the single render path: both the automatic pipeline
 * (jobs/processing.ts) and manual repair (jobs/rerender.ts) call this, so
 * a fix here (like the post-upload verification below) applies to both.
 *
 * A clip only becomes `ready` after render, upload, AND a post-upload
 * existence check all succeed — an upload call returning success is not
 * itself trusted, since that's exactly how the original missing-media bug
 * happened (a clip rendered before object storage was configured, whose
 * "success" only ever meant "wrote to a container's ephemeral disk").
 */
export async function performRenderAndUpload(
  moment: MomentWithVideo,
  tikTokVersionId: string,
  options: PerformRenderOptions = {},
): Promise<PerformRenderResult> {
  const { onStage = () => {}, deps = defaultDeps } = options;
  const scratchDir = scratchDirForRender(moment.id);

  try {
    const durationSeconds = moment.endSeconds - moment.startSeconds;
    onStage(
      `using existing timestamps ${moment.startSeconds.toFixed(1)} → ${moment.endSeconds.toFixed(1)}`,
    );

    const source = getSource(moment.sourceVideo.source.name);
    const availability = await source.getVideoSource(moment.sourceVideo.sourceVideoId);
    if (!availability.downloadable) {
      await markUnavailable(moment.id, tikTokVersionId, availability.reason);
      onStage(`source unavailable: ${availability.reason ?? "unknown reason"}`);
      return { outcome: "source_unavailable", message: availability.reason };
    }

    onStage("acquiring source media");
    let filePath: string;
    try {
      filePath = await deps.acquireVideo(availability, scratchDir);
    } catch (err) {
      if (!(err instanceof AcquisitionError)) throw err;
      const { classification } = err;
      onStage(`source acquisition failed: ${classification.message}`);

      if (classification.kind === "binary_missing" || classification.kind === "ffmpeg_missing") {
        await markFailed(moment.id, tikTokVersionId, classification.message, "error");
        await logError("render", `Media-acquisition environment problem for moment ${moment.id}`, err, {
          momentId: moment.id,
        });
        return { outcome: "environment_broken", message: classification.message, errorKind: classification.kind };
      }
      if (classification.isAccessBlocked) {
        await markSourceVideoAccessBlocked(moment.sourceVideo.id, classification.message);
        await markFailed(moment.id, tikTokVersionId, classification.message, "moment_found");
        return { outcome: "access_blocked", message: classification.message, errorKind: classification.kind };
      }
      await markFailed(moment.id, tikTokVersionId, classification.message, "error");
      await logError("render", `Media acquisition failed for moment ${moment.id}`, err, { momentId: moment.id });
      return { outcome: "failed", message: classification.message, errorKind: classification.kind };
    }
    onStage("source acquired");

    const info = await deps.probeVideo(filePath);

    const tracked = claudeVisionTracker.track({ rawKeyframes: moment.trackedKeyframes });
    // trackedKeyframes are in absolute source-video seconds; smart crop wants
    // them clip-relative.
    const relativeTracked = tracked.map((k) => ({
      ...k,
      timeSeconds: k.timeSeconds - moment.startSeconds,
    }));
    const cropKeyframes = computeSmartCropKeyframes(info, durationSeconds, relativeTracked);

    onStage("rendering 9:16");
    const renderedPath = path.join(scratchDir, "output.mp4");
    try {
      await deps.renderVerticalClip({
        sourceFilePath: filePath,
        outputFilePath: renderedPath,
        source: info,
        startSeconds: moment.startSeconds,
        endSeconds: moment.endSeconds,
        cropKeyframes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(moment.id, tikTokVersionId, message, "error");
      await logError("render", `ffmpeg render failed for moment ${moment.id}`, err, { momentId: moment.id });
      onStage(`ffmpeg render failed: ${message}`);
      return { outcome: "failed", message };
    }
    onStage("render complete");

    onStage("uploading to bucket");
    const storageKey = storageKeyFor(moment.id);
    let sizeBytes: number;
    try {
      ({ sizeBytes } = await deps.uploadToStorage(storageKey, renderedPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(moment.id, tikTokVersionId, message, "error");
      await logError("render", `Storage upload failed for moment ${moment.id}`, err, { momentId: moment.id });
      onStage(`bucket upload failed: ${message}`);
      return { outcome: "failed", message };
    }
    onStage("upload complete");

    const exists = await deps.verifyStorageObjectExists(storageKey);
    if (!exists) {
      const message = "Upload reported success but the object could not be verified in storage afterward";
      await markMediaMissing(moment.id, tikTokVersionId, message);
      await logError("render", `Post-upload verification failed for moment ${moment.id}`, undefined, {
        momentId: moment.id,
        storageKey,
      });
      onStage("object verification FAILED — upload did not persist");
      return { outcome: "media_missing", message };
    }
    onStage("object verified");

    await prisma.tikTokVersion.update({
      where: { id: tikTokVersionId },
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
    onStage("clip restored");
    return { outcome: "rendered" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError("render", `Render failed for moment ${moment.id}`, err, { momentId: moment.id });
    await markFailed(moment.id, tikTokVersionId, message, "error");
    onStage(`unexpected error: ${message}`);
    return { outcome: "failed", message };
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

async function markMediaMissing(momentId: string, tikTokVersionId: string, errorMessage: string): Promise<void> {
  await prisma.tikTokVersion.update({
    where: { id: tikTokVersionId },
    data: { status: "media_missing", errorMessage },
  });
  // Keep the moment itself visible/browsable on the dashboard (it did
  // finish analysis) — only the TikTok-specific render is affected.
  await prisma.detectedMoment.update({ where: { id: momentId }, data: { status: "ready" } });
}
