import { getSettings } from "@/database/settings";
import { runDiscovery, type DiscoveryRunSummary } from "@/discovery/runDiscovery";

/**
 * Entry point the worker/scheduler calls — separate from
 * `discovery/runDiscovery.ts` so the "should this even run right now"
 * check (the automatic-discovery toggle) lives with the other job
 * entry points in `src/jobs/`, not buried in the discovery internals.
 */
export async function runDiscoveryJob(opts: { force?: boolean } = {}): Promise<DiscoveryRunSummary | null> {
  const settings = await getSettings();
  if (!opts.force && !settings.automaticDiscoveryEnabled) return null;
  return runDiscovery();
}
