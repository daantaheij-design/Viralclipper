import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Category } from "@/generated/prisma";
import { analyzeFrames } from "@/ai/providers/claude";
import { extractFrames } from "@/video/ffmpeg";
import type { VideoInfo } from "@/video/types";
import { DetailedAnalysisResultSchema, OBSERVABLE_ONLY_RULE, type DetectedMoment } from "./schemas";
import type { QuickScanWindow } from "./quickScan";

const DENSE_FPS = 3;
const MAX_DENSE_FRAMES = 90; // caps request size for very long candidate windows

function systemPrompt(category: Category): string {
  return [
    `You are doing a careful, detailed review of one candidate segment from a "${category}"-style source video.`,
    OBSERVABLE_ONLY_RULE,
    "Find the complete, understandable story: setup, trigger, escalation, main action, peak, reaction, payoff/resolution — not just the shortest possible clip. Extend start/end as needed so nothing important is cut off.",
    "Do not require an extreme outcome — brake-checking, aggressive tailgating, a near miss, a confrontation, an unusual reaction, or anything a viewer would keep watching for all qualify. Judge by: would a viewer find this interesting enough to keep watching?",
    "If nothing here is actually interesting, set interesting_moment to false and return an empty moments array — do not force a result.",
    "For tracked_keyframes, give bounding boxes (normalized 0-1, origin top-left) for the main subject at 3-8 instants across the moment (always including its start, peak and end), and a secondary subject too whenever two vehicles/people are both needed to understand the interaction.",
  ].join(" ");
}

export interface DetailedAnalysisOutcome {
  moments: DetectedMoment[];
  costUsd: number;
}

/**
 * Pass 2: densely samples one candidate window and asks Claude to decide
 * whether it's actually a viral moment, find its true start/peak/end, score
 * it, and report subject bounding boxes for smart cropping.
 */
export interface DetailedAnalysisContext {
  runToken: string;
  sourceVideoId: string;
  analysisJobId?: string;
}

export async function runDetailedAnalysis(
  videoFilePath: string,
  scratchDir: string,
  video: VideoInfo,
  category: Category,
  window: QuickScanWindow,
  ctx: DetailedAnalysisContext,
): Promise<DetailedAnalysisOutcome> {
  const span = window.endSeconds - window.startSeconds;
  const fps = Math.min(DENSE_FPS, MAX_DENSE_FRAMES / Math.max(span, 1));

  const framesDir = path.join(scratchDir, `detailed-${Math.round(window.startSeconds)}`);
  const frames = await extractFrames(videoFilePath, framesDir, {
    startSeconds: window.startSeconds,
    endSeconds: window.endSeconds,
    framesPerSecond: fps,
  });

  try {
    const frameInputs = await Promise.all(
      frames.map(async (f) => ({
        base64: (await readFile(f.filePath)).toString("base64"),
        mediaType: "image/jpeg" as const,
        label: `Frame at t=${f.timeSeconds.toFixed(2)}s (clip-relative t=${(f.timeSeconds - window.startSeconds).toFixed(2)}s)`,
      })),
    );

    const result = await analyzeFrames({
      schema: DetailedAnalysisResultSchema,
      systemPrompt: systemPrompt(category),
      instructions:
        `This segment spans source video time ${window.startSeconds.toFixed(1)}s to ${window.endSeconds.toFixed(1)}s. ` +
        "Report start_seconds/peak_seconds/end_seconds and tracked_keyframes.time_seconds in the SAME absolute source-video time units as the frame labels above (not clip-relative). " +
        `Pass-1 flagged this window because: "${window.reason}".`,
      frames: frameInputs,
      operation: "detailed_analysis",
      runToken: ctx.runToken,
      sourceVideoId: ctx.sourceVideoId,
      analysisJobId: ctx.analysisJobId,
      maxTokens: 4000,
      frameDimensions: { width: video.width, height: video.height },
      candidateWindowStart: window.startSeconds,
      candidateWindowEnd: window.endSeconds,
    });

    if (!result.data.interesting_moment) {
      return { moments: [], costUsd: result.costUsd };
    }

    const moments = result.data.moments.filter((m) => {
      // Guard against a moment reported outside this window's actual bounds.
      return m.start_seconds >= window.startSeconds - 1 && m.end_seconds <= window.endSeconds + 1;
    });

    return { moments, costUsd: result.costUsd };
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}
