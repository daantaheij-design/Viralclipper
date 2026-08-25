import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Optional authenticated yt-dlp access via a cookies.txt file (Netscape
 * format), base64-encoded into YTDLP_COOKIES_BASE64. Entirely optional —
 * the app starts and runs fully without it, and this returns null when
 * unset. This is a fallback, not the primary production strategy: cookies
 * expire and the account they belong to can itself get rate-limited or
 * flagged, same as an unauthenticated request. See README.
 *
 * Never logs the decoded content or the base64 value — only whether a
 * cookies file is configured.
 */

let cachedPath: string | null | undefined; // undefined = not yet resolved this process

export async function getYtDlpCookiesPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  if (!env.ytdlpCookiesBase64) {
    cachedPath = null;
    return null;
  }

  const dir = path.join(env.scratchDir, "cookies");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "youtube-cookies.txt");
  const decoded = Buffer.from(env.ytdlpCookiesBase64, "base64");
  await writeFile(filePath, decoded, { mode: 0o600 });

  cachedPath = filePath;
  return filePath;
}
