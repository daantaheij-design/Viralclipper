import type { Category, SourceName } from "@/generated/prisma";

export interface DiscoveredVideo {
  sourceVideoId: string;
  url: string;
  title: string;
  description: string;
  thumbnailUrl?: string;
  channelName?: string;
  channelId?: string;
  durationSeconds?: number;
  uploadDate?: Date;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
}

export interface VideoStats {
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
}

/**
 * How to actually fetch the bytes at `VideoAvailability.url`:
 * - "yt-dlp": needs extraction (YouTube, and most Reddit-hosted videos,
 *   which split audio/video into separate streams yt-dlp merges).
 * - "direct-http": the URL already points straight at a media file a plain
 *   HTTP GET can fetch — no extractor, and importantly no yt-dlp-specific
 *   rate limiting/blocking risk. Some Reddit posts link directly to an
 *   .mp4/.mov/.webm this way.
 * Sources that don't set this are treated as "yt-dlp" (the common case).
 */
export type AcquisitionMethod = "yt-dlp" | "direct-http";

/** Whether we're able to fetch bytes for a video (for frame extraction / rendering). */
export interface VideoAvailability {
  downloadable: boolean;
  url: string;
  reason?: string;
  acquisitionMethod?: AcquisitionMethod;
}

export interface SearchOptions {
  limit: number;
  category: Category;
}

/**
 * Common interface every discovery source implements. Keep this the only
 * thing discovery/analysis code depends on — never import a specific
 * source's SDK/client outside of that source's own folder.
 */
export interface VideoSource {
  readonly name: SourceName;

  searchVideos(query: string, opts: SearchOptions): Promise<DiscoveredVideo[]>;
  getVideoMetadata(sourceVideoId: string): Promise<DiscoveredVideo | null>;
  getVideoSource(sourceVideoId: string): Promise<VideoAvailability>;
  getThumbnail(sourceVideoId: string): Promise<string | undefined>;
  getStats(sourceVideoId: string): Promise<VideoStats | null>;
}

export class SourceUnavailableError extends Error {
  constructor(
    public readonly source: SourceName,
    message: string,
  ) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}
