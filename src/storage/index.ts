import { env } from "@/lib/env";
import { localStorage } from "./local";
import { s3Storage } from "./s3";
import type { StorageBackend } from "./types";

export type { StorageBackend, ResolvedMedia, UploadResult } from "./types";

export function storageKeyFor(momentId: string): string {
  return `moments/${momentId}.mp4`;
}

/**
 * S3-compatible object storage when `S3_BUCKET` is configured, local disk
 * otherwise — the only place this choice is made. Everything else in the
 * app talks to `storage`, never to `local.ts`/`s3.ts` directly.
 */
export const storage: StorageBackend = env.s3Bucket ? s3Storage : localStorage;
