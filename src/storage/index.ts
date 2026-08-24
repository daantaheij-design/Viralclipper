import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Minimal local-disk storage for rendered TikTok exports, keyed the same
 * way object storage would be ("moments/{momentId}.mp4"). Swap this module
 * for an S3/R2-backed one later without touching callers — they only ever
 * see `storageKeyFor` / `absolutePathFor` / `fileExists`.
 */
export function storageKeyFor(momentId: string): string {
  return `moments/${momentId}.mp4`;
}

export function absolutePathFor(storageKey: string): string {
  return path.join(env.storageDir, storageKey);
}

export async function ensureStorageDirFor(storageKey: string): Promise<void> {
  await mkdir(path.dirname(absolutePathFor(storageKey)), { recursive: true });
}

export async function fileExists(storageKey: string): Promise<boolean> {
  try {
    await stat(absolutePathFor(storageKey));
    return true;
  } catch {
    return false;
  }
}

export async function fileSizeBytes(storageKey: string): Promise<number | undefined> {
  try {
    const s = await stat(absolutePathFor(storageKey));
    return s.size;
  } catch {
    return undefined;
  }
}
