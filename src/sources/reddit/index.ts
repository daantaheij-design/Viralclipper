import { env } from "@/lib/env";
import type {
  DiscoveredVideo,
  SearchOptions,
  VideoAvailability,
  VideoSource,
  VideoStats,
} from "@/sources/types";
import { SourceUnavailableError } from "@/sources/types";
import { getRedditAccessToken } from "./auth";

const API_BASE = "https://oauth.reddit.com";

interface RedditPostData {
  id: string;
  name: string;
  title: string;
  selftext: string;
  permalink: string;
  url: string;
  domain: string;
  author: string;
  subreddit: string;
  created_utc: number;
  ups: number;
  num_comments: number;
  thumbnail?: string;
  is_video: boolean;
  media?: { reddit_video?: { fallback_url: string; duration: number } };
  preview?: { images?: Array<{ source: { url: string } }> };
}

interface RedditListing {
  data: { children: Array<{ data: RedditPostData }> };
}

async function redditFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await getRedditAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": env.redditUserAgent,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SourceUnavailableError(
      "reddit",
      `Reddit API ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

function thumbnailOf(post: RedditPostData): string | undefined {
  if (post.thumbnail && post.thumbnail.startsWith("http")) return post.thumbnail;
  const preview = post.preview?.images?.[0]?.source?.url;
  return preview?.replace(/&amp;/g, "&");
}

function toDiscoveredVideo(post: RedditPostData): DiscoveredVideo {
  return {
    sourceVideoId: post.id,
    url: `https://www.reddit.com${post.permalink}`,
    title: post.title,
    description: post.selftext ?? "",
    thumbnailUrl: thumbnailOf(post),
    channelName: `r/${post.subreddit} (u/${post.author})`,
    channelId: post.subreddit,
    durationSeconds: post.media?.reddit_video?.duration,
    uploadDate: new Date(post.created_utc * 1000),
    viewCount: undefined, // Reddit does not expose view counts via the API
    likeCount: post.ups,
    commentCount: post.num_comments,
  };
}

/** True if this post is (or links directly to) a video we can plausibly download. */
function isVideoPost(post: RedditPostData): boolean {
  if (post.is_video && post.media?.reddit_video) return true;
  // Direct links to other platforms (youtube.com, v.redd.it, streamable, etc.)
  // are left to their own source connector when possible; a bare external
  // video link is still worth surfacing with downloadable=false until a
  // connector claims it.
  return /\.(mp4|mov|webm)(\?|$)/i.test(post.url);
}

export const redditSource: VideoSource = {
  name: "reddit",

  async searchVideos(query: string, opts: SearchOptions): Promise<DiscoveredVideo[]> {
    const data = await redditFetch<RedditListing>("/search", {
      q: query,
      type: "link",
      sort: "relevance",
      t: "week",
      limit: String(Math.min(opts.limit, 100)),
      restrict_sr: "false",
    });
    return data.data.children
      .map((c) => c.data)
      .filter(isVideoPost)
      .map(toDiscoveredVideo);
  },

  async getVideoMetadata(sourceVideoId: string): Promise<DiscoveredVideo | null> {
    const data = await redditFetch<RedditListing>(`/by_id/t3_${sourceVideoId}`, {});
    const post = data.data.children[0]?.data;
    return post ? toDiscoveredVideo(post) : null;
  },

  async getVideoSource(sourceVideoId: string): Promise<VideoAvailability> {
    const data = await redditFetch<RedditListing>(`/by_id/t3_${sourceVideoId}`, {});
    const post = data.data.children[0]?.data;
    if (!post) return { downloadable: false, url: "", reason: "post not found" };
    if (post.media?.reddit_video) {
      // v.redd.it splits audio/video into separate streams — needs yt-dlp
      // to extract and merge them, a plain GET on the permalink won't work.
      return {
        downloadable: true,
        url: `https://www.reddit.com${post.permalink}`,
        acquisitionMethod: "yt-dlp",
      };
    }
    if (/\.(mp4|mov|webm)(\?|$)/i.test(post.url)) {
      // A direct link straight to a media file — no extractor needed, and
      // no yt-dlp/YouTube-style rate-limiting risk either.
      return { downloadable: true, url: post.url, acquisitionMethod: "direct-http" };
    }
    return {
      downloadable: false,
      url: post.url,
      reason: "post is not a directly hosted video",
    };
  },

  async getThumbnail(sourceVideoId: string): Promise<string | undefined> {
    const video = await this.getVideoMetadata(sourceVideoId);
    return video?.thumbnailUrl;
  },

  async getStats(sourceVideoId: string): Promise<VideoStats | null> {
    const video = await this.getVideoMetadata(sourceVideoId);
    if (!video) return null;
    return { likeCount: video.likeCount, commentCount: video.commentCount };
  },
};
