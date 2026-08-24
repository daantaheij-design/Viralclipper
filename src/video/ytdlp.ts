import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import { getYtDlpCookiesPath } from "./ytdlpCookies";

/**
 * Downloads a video (by canonical platform URL, as returned from a
 * `VideoSource.getVideoSource()` call) into the scratch directory as an mp4,
 * capped at 1080p to keep frame extraction and rendering cheap. Throws if
 * the source turns out not to actually be downloadable (deleted, private,
 * geo-blocked, unsupported) — callers should treat that as a per-video
 * failure, not a pipeline-wide one.
 *
 * Prefer src/video/acquire.ts's `acquireVideo()` over calling this
 * directly — it adds request pacing, block detection/classification, and
 * routes non-yt-dlp sources around this entirely. This function is the
 * yt-dlp invocation itself, nothing more.
 */
export async function downloadVideo(url: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const outputTemplate = path.join(destDir, "source.%(ext)s");
  const cookiesPath = await getYtDlpCookiesPath();

  const args = [
    url,
    "-f",
    "bv*[height<=1080]+ba/b[height<=1080]/best",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    "--no-playlist",
    "--no-progress",
    "--newline",
    // YouTube's current player challenges require executing real
    // JavaScript to extract; without a JS runtime yt-dlp fails with "No
    // supported JavaScript runtime could be found". The Docker image
    // ships Node, so use it explicitly rather than relying on yt-dlp's
    // auto-detection.
    "--js-runtimes",
    "node",
  ];

  if (cookiesPath) args.push("--cookies", cookiesPath);

  await run(env.ytDlpPath, args, { timeoutMs: 15 * 60 * 1000 });

  return path.join(destDir, "source.mp4");
}
