import type { Category } from "@/generated/prisma";
import type { DiscoveredVideo } from "@/sources/types";
import { SEED_QUERIES } from "./seedQueries";

const MS_PER_HOUR = 1000 * 60 * 60;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** log-scale a count into 0..1, saturating around `saturateAt`. */
function logScore(value: number, saturateAt: number): number {
  if (value <= 0) return 0;
  return clamp(Math.log10(value + 1) / Math.log10(saturateAt + 1), 0, 1);
}

// Metadata-only, zero-cost signal of whether a video looks like raw/
// minimally-edited source footage vs. an edited repost — pre-ranks
// candidates BEFORE any acquisition/Anthropic spend (cost-control PR req
// #4). Not a hard gate (that's src/analysis/sourceCleanliness.ts, which
// looks at actual frames after acquisition) — just nudges priority order
// so raw footage tends to reach the AI budget check first.
const RAW_FOOTAGE_HINTS = ["dashcam", "dash cam", "bodycam", "body cam", "cctv", "raw footage", "full video", "original footage", "unedited"];
const REPOST_HINTS = ["#shorts", "#tiktok", "#reels", "shorts", "tiktok", "reaction", "compilation", "repost", "reupload"];

function formatPriorityDelta(video: DiscoveredVideo): number {
  const haystack = `${video.title} ${video.description}`.toLowerCase();
  let delta = 0;
  if (RAW_FOOTAGE_HINTS.some((h) => haystack.includes(h))) delta += 0.15;
  if (REPOST_HINTS.some((h) => haystack.includes(h))) delta -= 0.15;
  return delta;
}

function keywordRelevance(video: DiscoveredVideo, category: Category): number {
  const haystack = `${video.title} ${video.description}`.toLowerCase();
  const keywords = new Set<string>();
  for (const q of SEED_QUERIES[category] ?? []) {
    for (const word of q.toLowerCase().split(/\s+/)) {
      if (word.length > 3) keywords.add(word);
    }
  }
  if (keywords.size === 0) return 0.5;
  let hits = 0;
  for (const word of keywords) {
    if (haystack.includes(word)) hits++;
  }
  return clamp(hits / Math.min(keywords.size, 8), 0, 1);
}

export interface PreliminaryScoreResult {
  score: number; // 0-100
  viewVelocity?: number; // views/hour since upload
}

/**
 * Cheap, metadata-only score used to decide whether a discovered video is
 * worth spending AI budget on. Deliberately not view-count-only: view
 * velocity, recency, engagement and title/description relevance all
 * contribute, so a brand-new video with few views can still rank well.
 */
export function computePreliminaryScore(
  video: DiscoveredVideo,
  category: Category,
): PreliminaryScoreResult {
  const now = Date.now();
  const ageHours = video.uploadDate
    ? Math.max((now - video.uploadDate.getTime()) / MS_PER_HOUR, 0.5)
    : undefined;

  const viewVelocity =
    video.viewCount !== undefined && ageHours !== undefined
      ? video.viewCount / ageHours
      : undefined;

  const viewsComponent = logScore(video.viewCount ?? 0, 2_000_000); // 0..1
  const velocityComponent =
    viewVelocity !== undefined ? logScore(viewVelocity, 20_000) : 0; // 0..1

  const engagementRate =
    video.viewCount && video.viewCount > 0
      ? ((video.likeCount ?? 0) + (video.commentCount ?? 0)) / video.viewCount
      : 0;
  const engagementComponent = clamp(engagementRate / 0.08, 0, 1); // ~8% engagement saturates

  // Freshness: a video less than 72h old gets a floor bonus so it isn't
  // buried under old high-view-count videos purely for lacking view count yet.
  const freshnessComponent = ageHours !== undefined ? clamp(1 - ageHours / 72, 0, 1) : 0.3;

  const durationSeconds = video.durationSeconds ?? 120;
  // Extremely short clips rarely have room for setup+payoff; extremely long
  // ones are fine (we sparse-scan), just slightly deprioritized for cost.
  const durationComponent =
    durationSeconds < 8 ? 0.2 : durationSeconds > 3600 ? 0.6 : 1;

  const relevanceComponent = keywordRelevance(video, category);

  const weighted =
    viewsComponent * 0.2 +
    velocityComponent * 0.25 +
    engagementComponent * 0.15 +
    freshnessComponent * 0.15 +
    relevanceComponent * 0.2 +
    durationComponent * 0.05;

  const withFormatPriority = clamp(weighted + formatPriorityDelta(video), 0, 1);

  return {
    score: Math.round(withFormatPriority * 100),
    viewVelocity,
  };
}
