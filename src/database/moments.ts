import { prisma } from "./client";
import type { Category, ClipStatus, Prisma, SourceName } from "@/generated/prisma";

export type MomentView = "discover" | "top" | "saved" | "used" | "rejected";

const VIEW_STATUSES: Record<MomentView, ClipStatus[]> = {
  discover: ["moment_found", "tiktok_processing", "ready"],
  top: ["moment_found", "tiktok_processing", "ready", "saved", "used"],
  saved: ["saved", "editing"],
  used: ["used"],
  rejected: ["rejected"],
};

export type SortBy =
  | "viral_score"
  | "newest"
  | "most_viewed"
  | "shortest"
  | "longest"
  | "highest_confidence"
  | "recently_discovered";

export interface MomentFilters {
  view: MomentView;
  category?: Category;
  source?: SourceName;
  minScore?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxUploadAgeDays?: number;
  tiktokReadyOnly?: boolean;
  sortBy?: SortBy;
  since?: Date;
  limit?: number;
}

function orderByFor(sortBy: SortBy | undefined): Prisma.DetectedMomentOrderByWithRelationInput[] {
  switch (sortBy) {
    case "newest":
    case "recently_discovered":
      return [{ createdAt: "desc" }];
    case "most_viewed":
      return [{ sourceVideo: { viewCount: "desc" } }];
    case "shortest":
      return [{ endSeconds: "asc" }]; // duration isn't a column; approximate, refined client-side if needed
    case "longest":
      return [{ endSeconds: "desc" }];
    case "highest_confidence":
      return [{ confidence: "desc" }];
    case "viral_score":
    default:
      return [{ viralScore: "desc" }, { createdAt: "desc" }];
  }
}

export function momentListArgs(filters: MomentFilters) {
  const where: Prisma.DetectedMomentWhereInput = {
    status: { in: VIEW_STATUSES[filters.view] },
  };
  if (filters.category) where.category = filters.category;
  if (filters.minScore !== undefined) where.viralScore = { gte: filters.minScore };
  if (filters.since) where.createdAt = { gte: filters.since };
  if (filters.tiktokReadyOnly) where.tikTokVersion = { status: "ready" };

  const sourceVideoFilter: Prisma.SourceVideoWhereInput = {};
  if (filters.source) sourceVideoFilter.source = { name: filters.source };
  if (filters.maxUploadAgeDays !== undefined) {
    sourceVideoFilter.uploadDate = {
      gte: new Date(Date.now() - filters.maxUploadAgeDays * 24 * 60 * 60 * 1000),
    };
  }
  if (Object.keys(sourceVideoFilter).length > 0) where.sourceVideo = sourceVideoFilter;

  return {
    where,
    orderBy: orderByFor(filters.sortBy),
    take: filters.limit ?? 60,
    include: { sourceVideo: { include: { source: true } }, tikTokVersion: true },
  } satisfies Prisma.DetectedMomentFindManyArgs;
}

export async function listMoments(filters: MomentFilters) {
  const args = momentListArgs(filters);
  let moments = await prisma.detectedMoment.findMany(args);

  if (filters.minDurationSeconds !== undefined) {
    moments = moments.filter(
      (m) => m.endSeconds - m.startSeconds >= filters.minDurationSeconds!,
    );
  }
  if (filters.maxDurationSeconds !== undefined) {
    moments = moments.filter(
      (m) => m.endSeconds - m.startSeconds <= filters.maxDurationSeconds!,
    );
  }
  return moments;
}

export async function getMomentById(id: string) {
  return prisma.detectedMoment.findUnique({
    where: { id },
    include: { sourceVideo: { include: { source: true } }, tikTokVersion: true },
  });
}

export type MomentAction = "save" | "reject" | "use" | "editing" | "unsave";

export async function applyMomentAction(id: string, action: MomentAction) {
  const statusMap: Record<MomentAction, ClipStatus> = {
    save: "saved",
    reject: "rejected",
    use: "used",
    editing: "editing",
    unsave: "ready",
  };
  const timestampField: Partial<Record<MomentAction, "savedAt" | "usedAt" | "rejectedAt">> = {
    save: "savedAt",
    reject: "rejectedAt",
    use: "usedAt",
  };

  const data: Prisma.DetectedMomentUpdateInput = { status: statusMap[action] };
  const field = timestampField[action];
  if (field) data[field] = new Date();

  return prisma.detectedMoment.update({ where: { id }, data });
}
