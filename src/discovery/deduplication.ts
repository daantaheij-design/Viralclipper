import { createHash } from "node:crypto";
import { prisma } from "@/database/client";
import type { Category, SourceName } from "@/generated/prisma";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "to",
  "caught",
  "camera",
  "video",
  "compilation",
  "dashcam",
]);

/** Lowercase, strip punctuation/emoji and low-signal words, sort tokens. */
export function normalizeTitle(title: string): string {
  const tokens = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .sort();
  return tokens.join(" ");
}

export function titleFingerprint(title: string): string {
  return createHash("sha1").update(normalizeTitle(title)).digest("hex");
}

export interface DedupCheckInput {
  sourceName: SourceName;
  sourceVideoId: string;
  title: string;
  durationSeconds?: number;
  category: Category;
}

export interface DedupResult {
  isDuplicate: boolean;
  matchedSourceVideoId?: string;
  reason?: string;
}

/**
 * Checks whether a discovered video should be skipped as a duplicate:
 * either the exact (source, sourceVideoId) we've already stored, or a
 * near-identical title (same normalized fingerprint) with a similar
 * duration discovered recently — a common signature of reposts/crossposts
 * of the same incident.
 */
export async function checkDuplicate(input: DedupCheckInput): Promise<DedupResult> {
  const fingerprint = titleFingerprint(input.title);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const candidates = await prisma.sourceVideo.findMany({
    where: {
      titleFingerprint: fingerprint,
      category: input.category,
      discoveredAt: { gte: since },
    },
    select: { id: true, sourceId: true, durationSeconds: true },
    take: 5,
  });

  if (candidates.length === 0) return { isDuplicate: false };

  for (const c of candidates) {
    if (input.durationSeconds === undefined || c.durationSeconds === null) {
      return { isDuplicate: true, matchedSourceVideoId: c.id, reason: "same title fingerprint" };
    }
    const diff = Math.abs(c.durationSeconds - input.durationSeconds);
    const tolerance = Math.max(3, c.durationSeconds * 0.1);
    if (diff <= tolerance) {
      return {
        isDuplicate: true,
        matchedSourceVideoId: c.id,
        reason: "same title fingerprint + similar duration",
      };
    }
  }

  return { isDuplicate: false };
}
