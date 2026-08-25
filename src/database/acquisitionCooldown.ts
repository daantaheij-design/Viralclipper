import { prisma } from "./client";
import type { Prisma } from "@/generated/prisma";

// Exponential backoff for a source video that YouTube (or any other
// yt-dlp-backed source) has actively blocked acquisition of — 30min, 1h,
// 2h, 4h, ... capped at 24h. Deliberately not env-configurable: this is a
// "don't hammer a source that's blocking us" safety property, not a
// per-deploy tuning knob.
const BASE_COOLDOWN_MINUTES = 30;
const MAX_COOLDOWN_MINUTES = 24 * 60;

export function computeNextRetryAt(failureCount: number, now: Date = new Date()): Date {
  const exponent = Math.max(failureCount - 1, 0);
  const minutes = Math.min(BASE_COOLDOWN_MINUTES * 2 ** exponent, MAX_COOLDOWN_MINUTES);
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Marks a source video as access-blocked (see the `source_access_blocked`
 * status and the AcquisitionError.isAccessBlocked classification) and
 * schedules its next eligible retry with exponential backoff. The
 * discovery result itself (title, URL, metadata) is untouched — only the
 * processing status changes, so it still shows up wherever discovered
 * videos are surfaced.
 */
export async function markSourceVideoAccessBlocked(sourceVideoId: string, reason: string): Promise<void> {
  const current = await prisma.sourceVideo.findUniqueOrThrow({
    where: { id: sourceVideoId },
    select: { accessFailureCount: true },
  });
  const failureCount = current.accessFailureCount + 1;

  await prisma.sourceVideo.update({
    where: { id: sourceVideoId },
    data: {
      status: "source_access_blocked",
      errorMessage: reason,
      accessFailureCount: failureCount,
      nextRetryAt: computeNextRetryAt(failureCount),
    },
  });
}

/**
 * Prisma where-fragment for "this source video's cooldown, if any, has
 * elapsed" — true for anything that isn't currently `source_access_blocked`
 * at all, or that is but whose `nextRetryAt` has passed. Combine with an
 * AND alongside whatever other status filter a query needs.
 */
export function acquisitionEligible(now: Date = new Date()): Prisma.SourceVideoWhereInput {
  return {
    OR: [{ status: { not: "source_access_blocked" } }, { nextRetryAt: { lte: now } }],
  };
}
