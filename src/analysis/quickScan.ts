import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Category } from "@/generated/prisma";
import { analyzeFrames } from "@/ai/providers/claude";
import { extractFrames } from "@/video/ffmpeg";
import type { VideoInfo } from "@/video/types";
import { OBSERVABLE_ONLY_RULE, QuickScanResultSchema } from "./schemas";

// Quick scan answers ONE cheap question — "is there probably a worthwhile
// incident in this source worth paying for detailed analysis?" — never
// precise timestamps/scoring (that's detailed analysis's job). It is
// deliberately exactly ONE Anthropic request per candidate: a small, bounded
// number of low-resolution frames spanning the whole source, one call, done.
//
// This replaced an earlier design that sampled the whole video every 1.5s at
// native resolution and batched every 40 frames into its own Anthropic call
// — a real production incident where ONE candidate (a several-minute video)
// produced 2 separate ~$0.55 "quick_scan" requests (~109k input tokens each,
// consistent with ~40 native-1080p frames: (1920*1080/750)*1.25 ≈ 3458
// tokens/frame * 40 + overhead ≈ 139k estimated / ~109k actual) before a
// third was correctly blocked by the daily budget — defeating the entire
// point of a "cheap" pre-screen and starving detailed analysis of budget
// before it ever got a chance. See README's "A fourth production incident".
const MIN_QUICK_FRAMES = 6;
const MAX_QUICK_FRAMES = 12;
// Target spacing between sampled frames; actual frame count is always
// clamped to [MIN_QUICK_FRAMES, MAX_QUICK_FRAMES] regardless of duration —
// longer sources get denser sampling *within* that bound, never more
// requests.
const QUICK_FRAME_TARGET_INTERVAL_SECONDS = 20;
// 512x288 (16:9) — chosen over a smaller box like 384x216 because the
// marginal cost difference is a fraction of a cent (at these frame counts,
// well under $0.01 either way) while materially lower resolution risks
// missing exactly the kind of thing quick scan exists to catch (a distant
// brake-check, a small aggressive maneuver) — not worth the accuracy loss
// for negligible savings. Still ~14x fewer pixels than a native 1080p frame.
const QUICK_FRAME_MAX_WIDTH = 512;
const QUICK_FRAME_MAX_HEIGHT = 288;
// Quick scan's output is a short list of candidate windows (start/end/reason
// strings) — nowhere near detailed analysis's 4000-token budget. Capping
// this tightly matters because the pre-call budget RESERVATION treats
// maxTokens as the worst-case output cost, so an unnecessarily large cap
// inflates the reservation even though real output stays small (~200-250
// tokens, per production logs).
const QUICK_SCAN_MAX_OUTPUT_TOKENS = 1500;
const MIN_WINDOW_PADDING_SECONDS = 15;
const MIN_WINDOW_SPAN_SECONDS = 45;

function systemPrompt(category: Category): string {
  return [
    `You are doing a fast, cheap first pass over a full source video, looking for moments that could work as a short viral "${category}" clip.`,
    OBSERVABLE_ONLY_RULE,
    "Do not require an extreme outcome (crash, violence, arrest) — a brake check, a near miss, a confrontation, an unexpected reaction, or anything a viewer would keep watching for all count.",
    "You only need a rough sense of WHERE something promising might be — exact timing and scoring happen in a later, more careful pass over a shorter window, so err generously.",
    "For every candidate, return a GENEROUSLY padded window: include enough time before the moment for setup/context and enough after for the reaction/result. Do not return a tight window around just the peak instant.",
  ].join(" ");
}

export interface QuickScanWindow {
  startSeconds: number;
  endSeconds: number;
  reason: string;
}

/** Bounded to [MIN_QUICK_FRAMES, MAX_QUICK_FRAMES] regardless of duration — exported for tests. */
export function quickScanFrameCount(durationSeconds: number): number {
  if (durationSeconds <= 0) return MIN_QUICK_FRAMES;
  const target = Math.ceil(durationSeconds / QUICK_FRAME_TARGET_INTERVAL_SECONDS);
  return Math.min(MAX_QUICK_FRAMES, Math.max(MIN_QUICK_FRAMES, target));
}

/**
 * Pass 1: a single cheap, low-resolution, bounded-frame-count Anthropic call
 * that flags rough time windows worth a closer (expensive) look — never more
 * than one request per candidate.
 */
export interface QuickScanContext {
  runToken: string;
  sourceVideoId: string;
  analysisJobId?: string;
}

export async function runQuickScan(
  videoFilePath: string,
  scratchDir: string,
  video: VideoInfo,
  category: Category,
  ctx: QuickScanContext,
): Promise<{ windows: QuickScanWindow[]; costUsd: number }> {
  const framesDir = path.join(scratchDir, "quick-scan-frames");
  const frameCount = quickScanFrameCount(video.durationSeconds);
  const framesPerSecond = video.durationSeconds > 0 ? frameCount / video.durationSeconds : MIN_QUICK_FRAMES;

  const frames = await extractFrames(videoFilePath, framesDir, {
    startSeconds: 0,
    endSeconds: video.durationSeconds,
    framesPerSecond,
    maxWidth: QUICK_FRAME_MAX_WIDTH,
    maxHeight: QUICK_FRAME_MAX_HEIGHT,
  });

  try {
    const frameInputs = await Promise.all(
      frames.map(async (f) => ({
        base64: (await readFile(f.filePath)).toString("base64"),
        mediaType: "image/jpeg" as const,
        label: `Frame at t=${f.timeSeconds.toFixed(1)}s`,
      })),
    );

    const result = await analyzeFrames({
      schema: QuickScanResultSchema,
      systemPrompt: systemPrompt(category),
      instructions:
        `These ${frameInputs.length} frames are sparsely sampled across the full ${video.durationSeconds.toFixed(0)}s source video. ` +
        "List any candidate windows for a viral moment, with generous padding. " +
        "Return an empty list if nothing here looks promising.",
      frames: frameInputs,
      operation: "quick_scan",
      runToken: ctx.runToken,
      sourceVideoId: ctx.sourceVideoId,
      analysisJobId: ctx.analysisJobId,
      maxTokens: QUICK_SCAN_MAX_OUTPUT_TOKENS,
      // The bounding box requested from ffmpeg, not the source's native
      // dimensions — this is what actually gets sent to Anthropic, and
      // using the real (small) size is what keeps the budget reservation
      // honestly cheap instead of pessimistically pricing native-resolution
      // frames that were never sent.
      frameDimensions: { width: QUICK_FRAME_MAX_WIDTH, height: QUICK_FRAME_MAX_HEIGHT },
    });

    const windows: QuickScanWindow[] = [];
    for (const w of result.data.candidateWindows) {
      const paddedStart = Math.max(0, w.startSeconds - MIN_WINDOW_PADDING_SECONDS);
      const paddedEnd = Math.min(video.durationSeconds, w.endSeconds + MIN_WINDOW_PADDING_SECONDS);
      const span = paddedEnd - paddedStart;
      const finalEnd =
        span < MIN_WINDOW_SPAN_SECONDS
          ? Math.min(video.durationSeconds, paddedStart + MIN_WINDOW_SPAN_SECONDS)
          : paddedEnd;
      windows.push({ startSeconds: paddedStart, endSeconds: finalEnd, reason: w.reason });
    }

    return { windows: mergeOverlappingWindows(windows), costUsd: result.costUsd };
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}

/** Merges candidate windows that overlap so pass 2 doesn't re-analyze the same footage twice. */
function mergeOverlappingWindows(windows: QuickScanWindow[]): QuickScanWindow[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: QuickScanWindow[] = [sorted[0]];

  for (const w of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (w.startSeconds <= last.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, w.endSeconds);
      last.reason = `${last.reason}; ${w.reason}`;
    } else {
      merged.push(w);
    }
  }
  return merged;
}
