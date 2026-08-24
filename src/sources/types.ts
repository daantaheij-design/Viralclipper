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

/** Whether we're able to fetch bytes for a video (for frame extraction / rendering). */
export interface VideoAvailability {
  downloadable: boolean;
  url: string;
  reason?: string;
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
