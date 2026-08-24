import type { Category, ClipStatus, SourceName } from "@/generated/prisma";

export const CATEGORY_LABELS: Record<Category, string> = {
  road_rage: "Road Rage",
  dashcam: "Dashcam",
  instant_karma: "Instant Karma",
  crazy_driving: "Crazy Driving",
  near_misses: "Near Misses",
  crashes: "Crashes",
  confrontations: "Confrontations",
  arguments: "Arguments",
  fails: "Fails",
  funny_moments: "Funny Moments",
  unexpected_moments: "Unexpected Moments",
  satisfying_moments: "Satisfying Moments",
  shocking_moments: "Shocking Moments",
  weird_moments: "Weird Moments",
  general_viral: "General Viral",
};

export const SOURCE_LABELS: Record<SourceName, string> = {
  youtube: "YouTube",
  reddit: "Reddit",
};

export const STATUS_LABELS: Record<ClipStatus, string> = {
  moment_found: "Moment found",
  tiktok_processing: "Processing 9:16…",
  ready: "Ready",
  saved: "Saved",
  editing: "Editing",
  used: "Used",
  rejected: "Rejected",
  no_good_moment: "No good moment",
  error: "Error",
};

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${rounded} sec`;
}

export function formatCompactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function scoreColorClass(score: number): string {
  if (score >= 90) return "text-orange-400";
  if (score >= 80) return "text-amber-400";
  if (score >= 70) return "text-yellow-400";
  return "text-neutral-400";
}
