import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { VideoAvailability } from "@/sources/types";
import { AcquisitionError, classifySpawnError, classifyYtDlpStderr, isErrnoException } from "./acquisitionErrors";
import { throttleAcquisition } from "./acquisitionThrottle";
import { downloadVideo } from "./ytdlp";
import { ProcessError } from "@/lib/proc";

/**
 * The single entry point for turning a `VideoAvailability` into a local
 * video file, regardless of how — this is the provider abstraction: a
 * source that hands back a directly fetchable media URL never touches
 * yt-dlp (and so never inherits its YouTube-specific rate-limiting risk).
 * Only the "yt-dlp" path applies request pacing + block classification;
 * see acquisitionErrors.ts / acquisitionThrottle.ts.
 */
export async function acquireVideo(availability: VideoAvailability, destDir: string): Promise<string> {
  const method = availability.acquisitionMethod ?? "yt-dlp";
  return method === "direct-http"
    ? downloadDirect(availability.url, destDir)
    : downloadViaYtDlp(availability.url, destDir);
}

async function downloadViaYtDlp(url: string, destDir: string): Promise<string> {
  await throttleAcquisition();
  try {
    return await downloadVideo(url, destDir);
  } catch (err) {
    if (err instanceof ProcessError) {
      throw new AcquisitionError(classifyYtDlpStderr(err.result.stderr));
    }
    if (isErrnoException(err) && err.code === "ENOENT") {
      throw new AcquisitionError(classifySpawnError(err, "yt-dlp"));
    }
    throw err;
  }
}

async function downloadDirect(url: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, "source.mp4");

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new AcquisitionError({
      kind: "unknown",
      message: `Direct download failed: HTTP ${response.status} ${response.statusText}`,
      isAccessBlocked: false,
    });
  }

  // response.body is a DOM ReadableStream; Readable.fromWeb wants Node's
  // stream/web ReadableStream type — structurally identical at runtime,
  // just declared in two different lib.d.ts files.
  const webStream = response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>;
  await pipeline(Readable.fromWeb(webStream), createWriteStream(dest));

  return dest;
}
