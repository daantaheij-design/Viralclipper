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

  // Local disk path for scratch video work (downloaded source video,
  // extracted frames) — always local/ephemeral, never needs to be shared
  // between processes, so no object-storage equivalent exists for this one.
  scratchDir: optional("SCRATCH_DIR") ?? "/tmp/viral-clip-finder/scratch",

  // Where rendered 9:16 clips end up. Local disk by default (storageDir) —
  // fine for local dev or a single self-hosted process. Set S3_BUCKET (+
  // the other S3_* vars) to switch to S3-compatible object storage instead
  // (e.g. a Railway Storage Bucket) — required once the web and worker run
  // as separate services/containers that don't share a filesystem. See
  // src/storage/ and README's "Deploying to Railway" section.
  storageDir: optional("STORAGE_DIR") ?? "/tmp/viral-clip-finder/storage",

  s3Bucket: optional("S3_BUCKET"),
  s3Endpoint: optional("S3_ENDPOINT"),
  s3Region: optional("S3_REGION") ?? "auto",
  s3AccessKeyId: optional("S3_ACCESS_KEY_ID"),
  s3SecretAccessKey: optional("S3_SECRET_ACCESS_KEY"),

  ytDlpPath: optional("YTDLP_PATH") ?? "yt-dlp",
  ffmpegPath: optional("FFMPEG_PATH") ?? "ffmpeg",
  ffprobePath: optional("FFPROBE_PATH") ?? "ffprobe",

  ffmpegThreads: Number(optional("FFMPEG_THREADS") ?? "2"),

  // Minimum spacing, in ms, enforced between successive yt-dlp media
  // acquisitions (see src/video/acquisitionThrottle.ts) — this is about
  // pacing requests to YouTube itself, deliberately separate from
  // FFMPEG_THREADS (ffmpeg's own CPU thread cap). Default 5s: cheap
  // insurance against looking like a script hammering YouTube.
  youtubeAcquisitionDelayMs: Number(optional("YOUTUBE_ACQUISITION_DELAY_MS") ?? "5000"),

  // How many consecutive access-blocked results (429 / bot-check /
  // login-required) within one discovery/render run before that run gives
  // up on further YouTube acquisitions rather than continuing to work
  // through its remaining candidates — see AcquisitionCircuitBreaker.
  youtubeCircuitBreakerThreshold: Number(optional("YOUTUBE_CIRCUIT_BREAKER_THRESHOLD") ?? "3"),

  // Optional, entirely optional: a yt-dlp cookies.txt (Netscape format),
  // base64-encoded, for authenticated YouTube access. Never required to
  // start the app. See src/video/ytdlpCookies.ts — never logged.
  ytdlpCookiesBase64: optional("YTDLP_COOKIES_BASE64"),
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
