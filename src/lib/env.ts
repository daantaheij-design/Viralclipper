// Static configuration read from environment variables. Anything the user
// can change at runtime from the Settings page lives in the database
// instead (see src/database/settings.ts) — this file is only for
// credentials and deploy-time paths.

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  databaseUrl: optional("DATABASE_URL"),

  // Gate for the whole site — this is a private single-user tool, not
  // multi-tenant. Leave APP_PASSWORD unset to disable the gate entirely
  // (e.g. for local development).
  appPassword: optional("APP_PASSWORD"),
  sessionSecret: optional("SESSION_SECRET") ?? optional("APP_PASSWORD"),

  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  claudeModel: optional("CLAUDE_MODEL") ?? "claude-opus-5",

  youtubeApiKey: optional("YOUTUBE_API_KEY"),

  redditClientId: optional("REDDIT_CLIENT_ID"),
  redditClientSecret: optional("REDDIT_CLIENT_SECRET"),
  redditUserAgent: optional("REDDIT_USER_AGENT") ?? "viral-clip-finder/0.1 (by /u/unknown)",

  // Local disk paths used for scratch video work and rendered output.
  // A self-hosted deploy is expected (see README) — this is not designed
  // to run inside a stateless serverless function.
  scratchDir: optional("SCRATCH_DIR") ?? "/tmp/viral-clip-finder/scratch",
  storageDir: optional("STORAGE_DIR") ?? "/tmp/viral-clip-finder/storage",

  ytDlpPath: optional("YTDLP_PATH") ?? "yt-dlp",
  ffmpegPath: optional("FFMPEG_PATH") ?? "ffmpeg",
  ffprobePath: optional("FFPROBE_PATH") ?? "ffprobe",

  ffmpegThreads: Number(optional("FFMPEG_THREADS") ?? "2"),
};

export function requireAnthropicKey(): string {
  if (!env.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — AI analysis cannot run until it is configured.",
    );
  }
  return env.anthropicApiKey;
}

export function requireYouTubeKey(): string {
  if (!env.youtubeApiKey) {
    throw new Error(
      "YOUTUBE_API_KEY is not set — the YouTube source cannot search until it is configured.",
    );
  }
  return env.youtubeApiKey;
}
