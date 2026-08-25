import { getSettings } from "@/database/settings";
import { tryAcquireLock, releaseLock } from "@/database/jobLock";
import { runDiscovery, type DiscoveryRunSummary } from "@/discovery/runDiscovery";

const DISCOVERY_LOCK_NAME = "discovery";
// A discovery run is bounded (a fixed number of search-API calls), never
// video download/ffmpeg/Anthropic work — 30 minutes is a very generous
// ceiling before a lock is treated as abandoned by a crashed holder.
const DISCOVERY_STALE_AFTER_MS = 30 * 60 * 1000;

export type DiscoveryJobOutcome =
  | { outcome: "completed"; summary: DiscoveryRunSummary }
  | { outcome: "disabled" }
  | { outcome: "already_running" };

/**
 * Entry point the worker/scheduler and the manual "Run discovery now" route
 * both call — separate from `discovery/runDiscovery.ts` so the "should
 * this even run right now" checks (the automatic-discovery toggle, and the
 * DB-backed mutex) live with the other job entry points in `src/jobs/`, not
 * buried in the discovery internals. The lock is what turns three rapid
 * clicks of "Run discovery now" (or a worker tick racing a manual click)
 * into exactly one discovery run plus two `already_running` responses,
 * instead of three overlapping runs creating duplicate work/candidates.
 */
export async function runDiscoveryJob(opts: { force?: boolean } = {}): Promise<DiscoveryJobOutcome> {
  const settings = await getSettings();
  if (!opts.force && !settings.automaticDiscoveryEnabled) return { outcome: "disabled" };

  const lock = await tryAcquireLock(DISCOVERY_LOCK_NAME, DISCOVERY_STALE_AFTER_MS);
  if (!lock.acquired) return { outcome: "already_running" };

  try {
    const summary = await runDiscovery();
    return { outcome: "completed", summary };
  } finally {
    await releaseLock(DISCOVERY_LOCK_NAME, lock.token!);
  }
}
