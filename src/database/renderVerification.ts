import { prisma } from "./client";
import { storage } from "@/storage";
import { logError } from "@/lib/errorLog";
import type { Prisma } from "@/generated/prisma";

type MomentWithTikTokVersion = Prisma.DetectedMomentGetPayload<{
  include: { tikTokVersion: true };
}>;

/**
 * Read-repair: a TikTokVersion the database says is `ready` might not
 * actually have an object in storage anymore — most notably, a clip
 * rendered before object storage was configured only ever lived on a
 * container's ephemeral disk and was lost on redeploy. Rather than trust
 * the stored status, verify it here and flip it to `media_missing` (with
 * the moment itself left visible — only the render is affected) so the
 * dashboard never claims a clip is ready when the file is gone. Cheap:
 * `storage.exists()` is a single lightweight existence check per clip, and
 * this only runs for the (typically small) subset already marked `ready`.
 *
 * Mutates and returns the same array so callers can use it directly.
 */
export async function healStaleReadyStatuses<T extends MomentWithTikTokVersion>(moments: T[]): Promise<T[]> {
  const readyOnes = moments.filter(
    (m): m is T & { tikTokVersion: NonNullable<T["tikTokVersion"]> & { storageKey: string } } =>
      m.tikTokVersion?.status === "ready" && Boolean(m.tikTokVersion.storageKey),
  );
  if (readyOnes.length === 0) return moments;

  const checks = await Promise.all(
    readyOnes.map(async (m) => {
      try {
        const exists = await storage.exists(m.tikTokVersion.storageKey);
        return { tikTokVersionId: m.tikTokVersion.id, exists };
      } catch (err) {
        // Fail open: a transient storage error shouldn't make a genuinely
        // fine clip look broken. Leave its status alone and log it.
        await logError("render_verification", "Storage existence check failed", err, {
          tikTokVersionId: m.tikTokVersion.id,
        });
        return { tikTokVersionId: m.tikTokVersion.id, exists: true };
      }
    }),
  );

  const missingIds = checks.filter((c) => !c.exists).map((c) => c.tikTokVersionId);
  if (missingIds.length === 0) return moments;

  await prisma.tikTokVersion.updateMany({
    where: { id: { in: missingIds } },
    data: {
      status: "media_missing",
      errorMessage:
        "Storage object not found — the render was likely lost (e.g. before object storage was configured). Use Re-render to rebuild it.",
    },
  });

  // Patch the in-memory objects so the caller's response reflects reality
  // immediately, without a second round-trip to the database.
  for (const moment of moments) {
    if (moment.tikTokVersion && missingIds.includes(moment.tikTokVersion.id)) {
      moment.tikTokVersion.status = "media_missing";
    }
  }

  return moments;
}
