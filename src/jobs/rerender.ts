import { prisma } from "@/database/client";
import { storage } from "@/storage";
import { performRenderAndUpload, type PerformRenderResult } from "./renderCore";

export type RerenderResult = PerformRenderResult | { outcome: "not_found" };

function log(line: string): void {
  console.log(`[repair] ${line}`);
}

/**
 * Manually-triggered repair: rebuilds one moment's 9:16 clip and re-uploads
 * it, reusing everything already persisted from the original analysis
 * (timestamps, category, viral score, tracked subject keyframes) — never
 * calls Claude, never re-runs discovery/quick-scan/detailed-analysis. This
 * is what powers the dashboard's "Re-render 9:16" button, for both a clip
 * whose storage object went missing (e.g. rendered before object storage
 * was configured) and one whose render simply failed.
 *
 * Delegates the actual render+upload+verify to performRenderAndUpload —
 * the exact same path the automatic pipeline uses — so this can never
 * drift from "what does a real render actually do", and a fix to that
 * shared path (e.g. the post-upload existence check) benefits both.
 */
export async function repairRender(momentId: string): Promise<RerenderResult> {
  log(`checking render for moment ${momentId}`);

  const moment = await prisma.detectedMoment.findUnique({
    where: { id: momentId },
    include: { sourceVideo: { include: { source: true } }, tikTokVersion: true },
  });
  if (!moment) {
    log(`moment ${momentId} not found`);
    return { outcome: "not_found" };
  }

  if (moment.tikTokVersion?.storageKey) {
    const exists = await storage.exists(moment.tikTokVersion.storageKey).catch(() => false);
    log(exists ? "bucket object still exists — re-rendering anyway per request" : "bucket object missing");
  } else {
    log("no prior render found");
  }
  log("re-render requested");

  const tikTokVersion = await prisma.tikTokVersion.upsert({
    where: { momentId: moment.id },
    create: { momentId: moment.id, status: "processing" },
    update: { status: "processing", errorMessage: null },
  });
  await prisma.detectedMoment.update({ where: { id: moment.id }, data: { status: "tiktok_processing" } });

  const result = await performRenderAndUpload(moment, tikTokVersion.id, { onStage: log });

  if (result.outcome !== "rendered") {
    log(`repair did not complete (${result.outcome}): ${result.message ?? "no further detail"}`);
  }

  return result;
}
