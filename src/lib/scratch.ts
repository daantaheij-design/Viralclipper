import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

export function scratchDirForSourceVideo(sourceVideoId: string): string {
  return path.join(env.scratchDir, "source-videos", sourceVideoId);
}

export function scratchDirForRender(momentId: string): string {
  return path.join(env.scratchDir, "renders", momentId);
}

export async function cleanupScratchDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
