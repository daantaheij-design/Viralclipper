import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";

/**
 * Downloads a video (by canonical platform URL, as returned from a
 * `VideoSource.getVideoSource()` call) into the scratch directory as an mp4,
 * capped at 1080p to keep frame extraction and rendering cheap. Throws if
 * the source turns out not to actually be downloadable (deleted, private,
 * geo-blocked, unsupported) — callers should treat that as a per-video
 * failure, not a pipeline-wide one.
 */
export async function downloadVideo(url: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const outputTemplate = path.join(destDir, "source.%(ext)s");

  await run(
    env.ytDlpPath,
    [
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
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );

  return path.join(destDir, "source.mp4");
}
