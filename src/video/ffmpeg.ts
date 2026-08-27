import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import type { VideoInfo } from "./types";

interface FfprobeStream {
  codec_type: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}
interface FfprobeOutput {
  format: { duration?: string };
  streams: FfprobeStream[];
}

function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 30;
  const [num, den] = rate.split("/").map(Number);
  if (!den) return num || 30;
  return num / den;
}

export async function probeVideo(filePath: string): Promise<VideoInfo> {
  const result = await run(env.ffprobePath, [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    filePath,
  ]);
  const data = JSON.parse(result.stdout) as FfprobeOutput;
  const videoStream = data.streams.find((s) => s.codec_type === "video");
  const audioStream = data.streams.find((s) => s.codec_type === "audio");

  if (!videoStream) throw new Error(`No video stream found in ${filePath}`);

  return {
    durationSeconds: Number(data.format.duration ?? 0),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps: parseFrameRate(videoStream.r_frame_rate),
    hasAudio: Boolean(audioStream),
  };
}

export interface ExtractedFrame {
  timeSeconds: number;
  filePath: string;
}

/**
 * Extracts frames from `filePath` at a fixed rate (`framesPerSecond`) over
 * `[startSeconds, endSeconds)`, writing numbered jpgs into `destDir`.
 * Timestamps are computed from the requested rate/start rather than read
 * back from ffmpeg — keep this in sync if the sampling filter ever changes
 * to something ffmpeg computes internally (e.g. scene detection).
 *
 * `maxWidth`/`maxHeight`, when given, add a `scale=...:force_original_aspect_ratio=decrease`
 * stage so frames are resized by ffmpeg itself before ever touching disk —
 * this is what lets quickScan.ts request small, cheap frames instead of
 * paying to extract (and then have Anthropic tokenize) full native-resolution
 * frames for a pass that only needs a rough yes/no read on the source. Adding
 * `scale` doesn't change frame count or spacing, so it doesn't affect the
 * timestamp computation above.
 */
export async function extractFrames(
  filePath: string,
  destDir: string,
  opts: { startSeconds: number; endSeconds: number; framesPerSecond: number; maxWidth?: number; maxHeight?: number },
): Promise<ExtractedFrame[]> {
  await mkdir(destDir, { recursive: true });
  const duration = Math.max(opts.endSeconds - opts.startSeconds, 0);
  if (duration <= 0) return [];

  const filters = [`fps=${opts.framesPerSecond}`];
  if (opts.maxWidth && opts.maxHeight) {
    filters.push(`scale=${opts.maxWidth}:${opts.maxHeight}:force_original_aspect_ratio=decrease`);
  }

  const pattern = path.join(destDir, "frame_%06d.jpg");
  await run(env.ffmpegPath, [
    "-ss",
    String(opts.startSeconds),
    "-t",
    String(duration),
    "-i",
    filePath,
    "-vf",
    filters.join(","),
    "-q:v",
    "3",
    "-threads",
    String(env.ffmpegThreads),
    pattern,
  ]);

  const files = (await readdir(destDir)).filter((f) => f.endsWith(".jpg")).sort();
  const interval = 1 / opts.framesPerSecond;
  return files.map((file, i) => ({
    timeSeconds: opts.startSeconds + i * interval,
    filePath: path.join(destDir, file),
  }));
}
