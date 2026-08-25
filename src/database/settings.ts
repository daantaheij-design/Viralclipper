import { prisma } from "@/database/client";
import type { Category } from "@/generated/prisma";

export interface DiscoverySettings {
  automaticDiscoveryEnabled: boolean;
  discoveryFrequencyHours: number;
  enabledCategories: Category[];
  minViralScore: number;
  candidatesPerRun: number;
  // How many already-discovered SourceVideo candidates go through the FREE
  // local stage (acquisition + src/analysis/sourceCleanliness.ts) per
  // analysis tick. Deliberately independent of maxQuickScansPerRun below —
  // this batch costs bandwidth/ffmpeg time only, never Anthropic $, so it
  // can safely be much larger. See src/jobs/analysis.ts.
  freeLocalFilterBatchSize: number;
  // How many `waiting_for_ai` candidates may receive an actual PAID
  // Anthropic quick-scan call per analysis tick. Never governs the free
  // local stage above.
  maxQuickScansPerRun: number;
  maxDetailedAnalysesPerRun: number;
  maxRendersPerRun: number;

  // --- Cost control -----------------------------------------------------
  // Global emergency kill switch: when false, NO Anthropic call may happen
  // from anywhere (worker, manual discovery, Analyze Again, retries,
  // repair) — see src/ai/budget.ts::reserveAiBudget, which is the single
  // enforcement point every Anthropic call goes through.
  paidAiAnalysisEnabled: boolean;
  dailyAiBudgetUsd: number;
  perRunAiBudgetUsd: number;
  maxConcurrentAnthropicCalls: number;
  // Local, zero-Anthropic gates a video must pass before it's ever eligible
  // for a Claude call — see src/analysis/sourceCleanliness.ts and
  // src/discovery/categoryPrefilter.ts.
  minSourceCleanlinessScore: number;
  minPreCategoryRelevanceScore: number;
}

// SAFE PRODUCTION DEFAULTS. Automatic discovery and Paid AI Analysis both
// start OFF; budgets start deliberately tiny. This is intentional — see the
// "Critical cost-control" PR that added these: a $5 Anthropic credit top-up
// was burned through in a single day because nothing actually capped
// concurrent/total spend. Raise these from the Settings page only after you
// have reviewed them; do not flip Paid AI Analysis ON as part of a
// deployment/migration — that decision is the operator's alone.
export const DEFAULT_SETTINGS: DiscoverySettings = {
  automaticDiscoveryEnabled: false,
  discoveryFrequencyHours: 4,
  enabledCategories: ["road_rage"],
  minViralScore: 70,
  candidatesPerRun: 20,
  freeLocalFilterBatchSize: 25,
  maxQuickScansPerRun: 1,
  maxDetailedAnalysesPerRun: 1,
  maxRendersPerRun: 1,

  paidAiAnalysisEnabled: false,
  dailyAiBudgetUsd: 0.5,
  perRunAiBudgetUsd: 0.2,
  maxConcurrentAnthropicCalls: 1,
  minSourceCleanlinessScore: 75,
  minPreCategoryRelevanceScore: 70,
};

const SETTINGS_KEY = "discovery_settings";

export async function getSettings(): Promise<DiscoverySettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...(row.value as Partial<DiscoverySettings>) };
}

export async function updateSettings(
  patch: Partial<DiscoverySettings>,
): Promise<DiscoverySettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next },
    update: { value: next },
  });
  return next;
}
