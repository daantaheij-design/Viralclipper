import { env } from "@/lib/env";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Module-level (process-lifetime) state: acquisitions are already
// sequential by construction — every job loop that downloads video
// (jobs/analysis.ts, jobs/processing.ts) awaits one video at a time, never
// Promise.all — so this only needs to remember the last call's timestamp,
// not coordinate concurrent callers.
let lastAcquisitionAt = 0;

/**
 * Waits, if necessary, so at least `YOUTUBE_ACQUISITION_DELAY_MS` has
 * elapsed since the previous yt-dlp acquisition anywhere in this process —
 * across both analysis and render jobs, and across worker ticks. Call this
 * immediately before every yt-dlp invocation.
 */
export async function throttleAcquisition(): Promise<void> {
  const elapsed = Date.now() - lastAcquisitionAt;
  const remaining = env.youtubeAcquisitionDelayMs - elapsed;
  if (remaining > 0) await sleep(remaining);
  lastAcquisitionAt = Date.now();
}

/**
 * Aborts the rest of a discovery/render run once too many consecutive
 * acquisitions come back access-blocked (429 / bot-check / login-required)
 * — a strong signal this environment's IP is currently blocked, so
 * continuing to work through the remaining candidates would just be more
 * of the same hammering. One instance per run (`runAnalysis`/
 * `runProcessing` each create their own) — this is intentionally not
 * shared/global state; see src/database/acquisitionCooldown.ts for the
 * cross-run/cross-tick backoff (which *is* persisted, per video).
 */
export class AcquisitionCircuitBreaker {
  private consecutiveBlocks = 0;

  constructor(private readonly threshold: number = env.youtubeCircuitBreakerThreshold) {}

  /** Records an access-blocked result. Returns true once the batch should stop. */
  recordBlocked(): boolean {
    this.consecutiveBlocks++;
    return this.consecutiveBlocks >= this.threshold;
  }

  /** Records anything else (success, or a failure unrelated to blocking) — resets the streak. */
  recordNotBlocked(): void {
    this.consecutiveBlocks = 0;
  }

  get isOpen(): boolean {
    return this.consecutiveBlocks >= this.threshold;
  }
}
