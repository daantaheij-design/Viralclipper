import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Category } from "@/generated/prisma";
import { analyzeFrames } from "@/ai/providers/claude";
import { extractFrames } from "@/video/ffmpeg";
import type { VideoInfo } from "@/video/types";
import { OBSERVABLE_ONLY_RULE, QuickScanResultSchema } from "./schemas";

const SPARSE_INTERVAL_SECONDS = 1.5;
const FRAMES_PER_BATCH = 40; // ~40 frames/batch keeps each request a reasonable size
const MIN_WINDOW_PADDING_SECONDS = 15;
const MIN_WINDOW_SPAN_SECONDS = 45;

function systemPrompt(category: Category): string {
  return [
    `You are doing a fast, cheap first pass over a full source video, looking for moments that could work as a short viral "${category}" clip.`,
    OBSERVABLE_ONLY_RULE,
    "Do not require an extreme outcome (crash, violence, arrest) — a brake check, a near miss, a confrontation, an unexpected reaction, or anything a viewer would keep watching for all count.",
    "For every candidate, return a GENEROUSLY padded window: include enough time before the moment for setup/context and enough after for the reaction/result. Do not return a tight window around just the peak instant.",
  ].join(" ");
}

export interface QuickScanWindow {
  startSeconds: number;
  endSeconds: number;
  reason: string;
}

/**
 * Pass 1: sparsely samples the whole video and asks Claude to flag rough
 * time windows worth a closer (expensive) look. Frames are pulled in
 * batches so an hour-long video doesn't become one giant request.
 */
export async function runQuickScan(
  videoFilePath: string,
  scratchDir: string,
  video: VideoInfo,
  category: Category,
): Promise<{ windows: QuickScanWindow[]; costUsd: number }> {
  const framesDir = path.join(scratchDir, "quick-scan-frames");
  const frames = await extractFrames(videoFilePath, framesDir, {
    startSeconds: 0,
    endSeconds: video.durationSeconds,
    framesPerSecond: 1 / SPARSE_INTERVAL_SECONDS,
  });

  const windows: QuickScanWindow[] = [];
  let costUsd = 0;

  try {
    for (let i = 0; i < frames.length; i += FRAMES_PER_BATCH) {
      const batch = frames.slice(i, i + FRAMES_PER_BATCH);
      const frameInputs = await Promise.all(
        batch.map(async (f) => ({
          base64: (await readFile(f.filePath)).toString("base64"),
          mediaType: "image/jpeg" as const,
          label: `Frame at t=${f.timeSeconds.toFixed(1)}s`,
        })),
      );

      const result = await analyzeFrames({
        schema: QuickScanResultSchema,
        systemPrompt: systemPrompt(category),
        instructions:
          "These frames are sampled roughly every " +
          `${SPARSE_INTERVAL_SECONDS}s from a segment of the source video. ` +
          "List any candidate windows for a viral moment, with generous padding. " +
          "Return an empty list if nothing here looks promising.",
        frames: frameInputs,
        operation: "quick_scan",
        maxTokens: 4000,
      });
      costUsd += result.costUsd;

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
    }
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }

  return { windows: mergeOverlappingWindows(windows), costUsd };
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
