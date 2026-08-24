import { prisma } from "@/database/client";
import type { Category } from "@/generated/prisma";

export interface DiscoverySettings {
  automaticDiscoveryEnabled: boolean;
  discoveryFrequencyHours: number;
  enabledCategories: Category[];
  minViralScore: number;
  candidatesPerRun: number;
  maxQuickScansPerRun: number;
  maxDetailedAnalysesPerRun: number;
  maxRendersPerRun: number;
  dailyAiBudgetUsd: number;
}

// Deliberately conservative for the first live run against real
// YouTube/Anthropic/ffmpeg infrastructure — one category, small caps at every
// stage. Raise these from the Settings page once a full run has been
// verified end to end.
export const DEFAULT_SETTINGS: DiscoverySettings = {
  automaticDiscoveryEnabled: true,
  discoveryFrequencyHours: 4,
  enabledCategories: ["road_rage"],
  minViralScore: 70,
  candidatesPerRun: 20,
  maxQuickScansPerRun: 5,
  maxDetailedAnalysesPerRun: 2,
  maxRendersPerRun: 2,
  dailyAiBudgetUsd: 5,
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
