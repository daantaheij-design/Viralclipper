/**
 * Classifies why a media-acquisition attempt (yt-dlp, or any future
 * provider) failed, so callers can tell "the source is actively blocking
 * us" apart from "this one video/attempt just failed" and from
 * "the environment itself is broken" — each needs different handling.
 * Pure/no I/O so it's directly unit-testable against real yt-dlp output.
 */

export type AcquisitionErrorKind =
  | "rate_limited" // HTTP 429
  | "bot_check" // "Sign in to confirm you're not a bot"
  | "login_required" // LOGIN_REQUIRED — the video needs an authenticated session
  | "binary_missing" // yt-dlp itself isn't on PATH (spawn ENOENT)
  | "ffmpeg_missing" // ffmpeg/ffprobe isn't on PATH (spawn ENOENT)
  | "unknown";

export interface ClassifiedAcquisitionError {
  kind: AcquisitionErrorKind;
  message: string;
  /**
   * True for failures that mean the source is actively refusing us (rate
   * limiting, bot/CAPTCHA challenges, sign-in walls) — the caller should
   * back off and stop retrying quickly, rather than treating this like an
   * ordinary one-off failure. False for missing binaries (an environment
   * problem, not the source's doing) and anything unrecognized.
   */
  isAccessBlocked: boolean;
}

function classified(
  kind: AcquisitionErrorKind,
  message: string,
  isAccessBlocked: boolean,
): ClassifiedAcquisitionError {
  return { kind, message, isAccessBlocked };
}

/** Classifies yt-dlp's stderr output from a non-zero exit. */
export function classifyYtDlpStderr(stderr: string): ClassifiedAcquisitionError {
  const text = stderr ?? "";

  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return classified(
      "rate_limited",
      "YouTube returned HTTP 429 (Too Many Requests) — this IP is being rate-limited",
      true,
    );
  }
  if (/sign in to confirm you.{0,3}re not a bot/i.test(text)) {
    return classified(
      "bot_check",
      "YouTube served a bot-check challenge (\"Sign in to confirm you're not a bot\")",
      true,
    );
  }
  if (/LOGIN_REQUIRED/i.test(text)) {
    return classified(
      "login_required",
      "YouTube requires an authenticated session for this video (LOGIN_REQUIRED)",
      true,
    );
  }

  return classified("unknown", text.trim().slice(0, 500) || "yt-dlp failed with no stderr output", false);
}

/** Classifies a raw Node spawn error (e.g. ENOENT when a binary isn't on PATH). */
export function classifySpawnError(
  err: NodeJS.ErrnoException,
  binary: "yt-dlp" | "ffmpeg" | "ffprobe",
): ClassifiedAcquisitionError {
  if (err.code === "ENOENT") {
    return classified(
      binary === "yt-dlp" ? "binary_missing" : "ffmpeg_missing",
      `${binary} is not installed / not on PATH`,
      false,
    );
  }
  return classified("unknown", err.message, false);
}

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Thrown by src/video/acquire.ts — carries the classification for callers to branch on. */
export class AcquisitionError extends Error {
  constructor(public readonly classification: ClassifiedAcquisitionError) {
    super(classification.message);
    this.name = "AcquisitionError";
  }
}
