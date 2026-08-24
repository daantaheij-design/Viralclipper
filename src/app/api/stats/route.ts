import { NextResponse } from "next/server";
import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { todaySpendUsd } from "@/ai/costTracking";

export const dynamic = "force-dynamic";

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function GET() {
  const settings = await getSettings();
  const since = startOfTodayUtc();

  const [
    videosDiscovered,
    videosDiscoveredToday,
    videosScanned,
    goodMoments,
    clipsReady,
    totalCostAgg,
    todayCost,
    lastDiscoveryRun,
  ] = await Promise.all([
    prisma.sourceVideo.count(),
    prisma.sourceVideo.count({ where: { discoveredAt: { gte: since } } }),
    prisma.sourceVideo.count({ where: { status: { in: ["scanned", "no_candidates", "error"] } } }),
    prisma.detectedMoment.count({ where: { viralScore: { gte: settings.minViralScore } } }),
    prisma.tikTokVersion.count({ where: { status: "ready" } }),
    prisma.apiUsage.aggregate({ _sum: { costUsd: true } }),
    todaySpendUsd(),
    prisma.discoveryRun.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);

  const totalCostUsd = totalCostAgg._sum.costUsd ?? 0;
  const avgCostPerGoodClip = goodMoments > 0 ? totalCostUsd / goodMoments : 0;

  return NextResponse.json({
    videosDiscovered,
    videosDiscoveredToday,
    videosScanned,
    goodMoments,
    clipsReady,
    totalCostUsd,
    aiCostTodayUsd: todayCost,
    avgCostPerGoodClip,
    dailyAiBudgetUsd: settings.dailyAiBudgetUsd,
    lastDiscoveryRun,
  });
}
