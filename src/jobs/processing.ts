import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { acquisitionEligible } from "@/database/acquisitionCooldown";
import { AcquisitionCircuitBreaker } from "@/video/acquisitionThrottle";
import { logError } from "@/lib/errorLog";
import { performRenderAndUpload, type MomentWithVideo } from "./renderCore";

export interface ProcessingRunSummary {
  rendered: number;
  failed: number;
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
    const outcome = await renderOneMoment(moment);
    if (outcome === "rendered") rendered++;
    else failed++;

    if (outcome === "environment_broken") {
      await logError(
        "render",
        "Stopping this render run early: the media-acquisition environment (yt-dlp/ffmpeg) is unusable, so the remaining moments would fail identically",
      );
      break;
    }

    if (outcome !== "access_blocked") {
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

async function renderOneMoment(moment: MomentWithVideo) {
  await prisma.detectedMoment.update({ where: { id: moment.id }, data: { status: "tiktok_processing" } });
  const tikTokVersion = await prisma.tikTokVersion.upsert({
    where: { momentId: moment.id },
    create: { momentId: moment.id, status: "processing" },
    update: { status: "processing", errorMessage: null },
  });

  const result = await performRenderAndUpload(moment, tikTokVersion.id);
  return result.outcome;
}
