import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import type { StorageBackend } from "./types";

/** Local-disk storage — the default for local development and any deploy
 * where the web and worker processes share a filesystem. */

function absolutePathFor(storageKey: string): string {
  return path.join(env.storageDir, storageKey);
}

export const localStorage: StorageBackend = {
  kind: "local",

  async upload(storageKey, localFilePath) {
    const dest = absolutePathFor(storageKey);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(localFilePath, dest);
    const stats = await stat(dest);
    return { sizeBytes: stats.size };
  },

  async exists(storageKey) {
    try {
      await stat(absolutePathFor(storageKey));
      return true;
    } catch {
      return false;
    }
  },

  async resolve(storageKey) {
    const filePath = absolutePathFor(storageKey);
    try {
      await stat(filePath);
    } catch {
      return null;
    }
    return { type: "stream", path: filePath };
  },
};
