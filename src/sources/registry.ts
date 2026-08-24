import type { SourceName } from "@/generated/prisma";
import type { VideoSource } from "@/sources/types";
import { youtubeSource } from "@/sources/youtube";
import { redditSource } from "@/sources/reddit";

/**
 * Every supported discovery source, keyed by its `SourceName`. Adding a new
 * platform connector means: implement `VideoSource` in its own folder under
 * `src/sources/<name>/`, then add one line here — nothing else in
 * discovery/analysis should need to change.
 */
export const SOURCE_REGISTRY: Record<SourceName, VideoSource> = {
  youtube: youtubeSource,
  reddit: redditSource,
};

export function getSource(name: SourceName): VideoSource {
  const source = SOURCE_REGISTRY[name];
  if (!source) throw new Error(`Unknown source: ${name}`);
  return source;
}

export function allSourceNames(): SourceName[] {
  return Object.keys(SOURCE_REGISTRY) as SourceName[];
}
