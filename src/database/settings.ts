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
  dailyAiBudgetUsd: number;
}

export const DEFAULT_SETTINGS: DiscoverySettings = {
  automaticDiscoveryEnabled: true,
  discoveryFrequencyHours: 4,
  enabledCategories: [
    "road_rage",
    "dashcam",
    "instant_karma",
    "crazy_driving",
    "near_misses",
    "crashes",
    "confrontations",
    "fails",
  ],
  minViralScore: 70,
  candidatesPerRun: 500,
  maxQuickScansPerRun: 100,
  maxDetailedAnalysesPerRun: 25,
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
