import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import type { CropKeyframe, VideoInfo } from "./types";

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

/** Drops keyframes that don't change position from their predecessor, so a
 * static (unpanned) clip produces a short, cheap-to-evaluate expression. */
function simplifyKeyframes(keyframes: CropKeyframe[]): CropKeyframe[] {
  const out: CropKeyframe[] = [];
  for (const k of keyframes) {
    const prev = out[out.length - 1];
    if (prev && prev.x === k.x && prev.y === k.y) continue;
    out.push(k);
  }
  return out;
}

/** Builds a piecewise-linear ffmpeg expression for one axis over time `t`. */
function buildAxisExpression(keyframes: CropKeyframe[], axis: "x" | "y"): string {
  if (keyframes.length === 0) return "0";
  if (keyframes.length === 1) return String(keyframes[0][axis]);

  let expr = String(keyframes[keyframes.length - 1][axis]);
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const span = b.timeSeconds - a.timeSeconds || 1;
    const lerp = `(${a[axis]}+(${b[axis]}-${a[axis]})*(t-${a.timeSeconds})/${span})`;
    expr = `if(lt(t,${b.timeSeconds}),${lerp},${expr})`;
  }
  return expr;
}

export interface RenderOptions {
  sourceFilePath: string;
  outputFilePath: string;
  source: VideoInfo;
  startSeconds: number;
  endSeconds: number;
  cropKeyframes: CropKeyframe[];
}

/**
 * Renders the clean 9:16 TikTok-ready export: trim to [start, end], pan a
 * fixed-size crop window per `cropKeyframes`, scale to 1080x1920, keep
 * original audio verbatim. Deliberately does nothing else — no captions,
 * text, music, overlays, or transitions (see project brief: creative
 * editing happens outside this tool).
 */
export async function renderVerticalClip(opts: RenderOptions): Promise<void> {
  await mkdir(path.dirname(opts.outputFilePath), { recursive: true });

  const duration = opts.endSeconds - opts.startSeconds;
  if (duration <= 0) throw new Error("renderVerticalClip: end must be after start");

  const keyframes = simplifyKeyframes(opts.cropKeyframes);
  const first = keyframes[0] ?? { x: 0, y: 0, w: opts.source.width, h: opts.source.height };
  const cropW = first.w;
  const cropH = first.h;
  const xExpr = buildAxisExpression(keyframes, "x");
  const yExpr = buildAxisExpression(keyframes, "y");

  const filter = [
    `crop=${cropW}:${cropH}:x='${xExpr}':y='${yExpr}'`,
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos`,
    "setsar=1",
  ].join(",");

  const args = [
    "-ss",
    String(opts.startSeconds),
    "-t",
    String(duration),
    "-i",
    opts.sourceFilePath,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    String(env.ffmpegThreads),
    "-filter_threads",
    String(env.ffmpegThreads),
    "-filter_complex_threads",
    String(env.ffmpegThreads),
    "-x264-params",
    `threads=${env.ffmpegThreads}`,
  ];

  if (opts.source.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", "-y", opts.outputFilePath);

  await run(env.ffmpegPath, args, { timeoutMs: 20 * 60 * 1000 });
}
