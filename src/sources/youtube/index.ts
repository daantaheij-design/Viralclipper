import { requireYouTubeKey } from "@/lib/env";
import type {
  DiscoveredVideo,
  SearchOptions,
  VideoAvailability,
  VideoSource,
  VideoStats,
} from "@/sources/types";
import { SourceUnavailableError } from "@/sources/types";
import { parseIso8601Duration } from "./parseDuration";

const API_BASE = "https://www.googleapis.com/youtube/v3";

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    channelId: string;
    publishedAt: string;
    thumbnails?: { high?: { url: string }; medium?: { url: string }; default?: { url: string } };
  };
}

interface YouTubeVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    channelId: string;
    publishedAt: string;
    thumbnails?: { high?: { url: string }; medium?: { url: string }; default?: { url: string } };
  };
  contentDetails: { duration: string };
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
}

async function ytFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const apiKey = requireYouTubeKey();
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SourceUnavailableError(
      "youtube",
      `YouTube API ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

function bestThumbnail(t?: YouTubeSearchItem["snippet"]["thumbnails"]): string | undefined {
  return t?.high?.url ?? t?.medium?.url ?? t?.default?.url;
}

function toDiscoveredVideo(item: YouTubeVideoItem): DiscoveredVideo {
  return {
    sourceVideoId: item.id,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    title: item.snippet.title,
    description: item.snippet.description ?? "",
    thumbnailUrl: bestThumbnail(item.snippet.thumbnails),
    channelName: item.snippet.channelTitle,
    channelId: item.snippet.channelId,
    durationSeconds: parseIso8601Duration(item.contentDetails.duration),
    uploadDate: new Date(item.snippet.publishedAt),
    viewCount: item.statistics.viewCount ? Number(item.statistics.viewCount) : undefined,
    likeCount: item.statistics.likeCount ? Number(item.statistics.likeCount) : undefined,
    commentCount: item.statistics.commentCount ? Number(item.statistics.commentCount) : undefined,
  };
}

async function videosByIds(ids: string[]): Promise<DiscoveredVideo[]> {
  if (ids.length === 0) return [];
  const out: DiscoveredVideo[] = [];
  // videos.list accepts at most 50 ids per call.
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await ytFetch<{ items: YouTubeVideoItem[] }>("videos", {
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
    });
    out.push(...data.items.map(toDiscoveredVideo));
  }
  return out;
}

export const youtubeSource: VideoSource = {
  name: "youtube",

  async searchVideos(query: string, opts: SearchOptions): Promise<DiscoveredVideo[]> {
    const data = await ytFetch<{ items: YouTubeSearchItem[] }>("search", {
      part: "snippet",
      q: query,
      type: "video",
      order: "relevance",
      videoDuration: "any",
      safeSearch: "none",
      maxResults: String(Math.min(opts.limit, 50)),
    });
    const ids = data.items.map((i) => i.id.videoId).filter(Boolean);
    return videosByIds(ids);
  },

  async getVideoMetadata(sourceVideoId: string): Promise<DiscoveredVideo | null> {
    const videos = await videosByIds([sourceVideoId]);
    return videos[0] ?? null;
  },

  async getVideoSource(sourceVideoId: string): Promise<VideoAvailability> {
    // yt-dlp supports YouTube; actual availability (private/region-locked/
    // deleted) is only known once we try to download it, so this is
    // optimistic and the downloader reports the real failure.
    return {
      downloadable: true,
      url: `https://www.youtube.com/watch?v=${sourceVideoId}`,
    };
  },

  async getThumbnail(sourceVideoId: string): Promise<string | undefined> {
    const video = await this.getVideoMetadata(sourceVideoId);
    return video?.thumbnailUrl;
  },

  async getStats(sourceVideoId: string): Promise<VideoStats | null> {
    const video = await this.getVideoMetadata(sourceVideoId);
    if (!video) return null;
    return {
      viewCount: video.viewCount,
      likeCount: video.likeCount,
      commentCount: video.commentCount,
    };
  },
};
