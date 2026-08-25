import { NextResponse } from "next/server";
import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { getBudgetStatus } from "@/ai/budget";

export const dynamic = "force-dynamic";

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function GET() {
  const settings = await getSettings();
  const since = startOfTodayUtc();
  const budget = await getBudgetStatus();

  const [
    videosDiscovered,
    videosDiscoveredToday,
    videosScanned,
    goodMoments,
    clipsReady,
    totalCostAgg,
    lastDiscoveryRun,
    filteredOutCount,
    dirtyLeadCount,
    waitingForAiCount,
    cleanCandidateCount,
    quickScanUsage,
    detailedAnalysisUsage,
    quickScanCostAgg,
    detailedAnalysisCostAgg,
    callsToday,
  ] = await Promise.all([
    prisma.sourceVideo.count(),
    prisma.sourceVideo.count({ where: { discoveredAt: { gte: since } } }),
    prisma.sourceVideo.count({ where: { status: { in: ["scanned", "no_candidates", "error"] } } }),
    prisma.detectedMoment.count({ where: { viralScore: { gte: settings.minViralScore } } }),
    prisma.tikTokVersion.count({ where: { status: "ready" } }),
    prisma.apiUsage.aggregate({ where: { provider: "anthropic" }, _sum: { costUsd: true } }),
    prisma.discoveryRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.sourceVideo.count({ where: { status: "filtered_out" } }),
    prisma.sourceVideo.count({ where: { status: "dirty_lead" } }),
    prisma.sourceVideo.count({ where: { status: "waiting_for_ai" } }),
    prisma.sourceVideo.count({ where: { sourceCleanlinessScore: { gte: settings.minSourceCleanlinessScore } } }),
    prisma.apiUsage.count({ where: { provider: "anthropic", operation: "quick_scan" } }),
    prisma.apiUsage.count({ where: { provider: "anthropic", operation: "detailed_analysis" } }),
    prisma.apiUsage.aggregate({
      where: { provider: "anthropic", operation: "quick_scan" },
      _sum: { costUsd: true },
    }),
    prisma.apiUsage.aggregate({
      where: { provider: "anthropic", operation: "detailed_analysis" },
      _sum: { costUsd: true },
    }),
    prisma.apiUsage.count({ where: { provider: "anthropic", createdAt: { gte: since } } }),
  ]);

  const totalCostUsd = totalCostAgg._sum.costUsd ?? 0;
  const avgCostPerGoodClip = goodMoments > 0 ? totalCostUsd / goodMoments : 0;
  const avgCostPerScannedCandidate = quickScanUsage > 0 ? totalCostUsd / quickScanUsage : 0;
  const quickScanCostUsd = quickScanCostAgg._sum.costUsd ?? 0;
  const detailedAnalysisCostUsd = detailedAnalysisCostAgg._sum.costUsd ?? 0;

  return NextResponse.json({
    // Legacy top-line tiles (unchanged shape, existing dashboard consumers).
    videosDiscovered,
    videosDiscoveredToday,
    videosScanned,
    goodMoments,
    clipsReady,
    totalCostUsd,
    aiCostTodayUsd: budget.confirmedTodayUsd,
    avgCostPerGoodClip,
    dailyAiBudgetUsd: settings.dailyAiBudgetUsd,
    lastDiscoveryRun,

    // Funnel — where videos are being rejected, and at what stage, before
    // any Anthropic cost is incurred. See README's "Cost control" section.
    funnel: {
      videosDiscovered,
      rejectedByMetadata: lastDiscoveryRun?.duplicatesSkipped ?? 0,
      rejectedWrongCategory: filteredOutCount,
      rejectedDirtySource: dirtyLeadCount,
      cleanCandidates: cleanCandidateCount,
      sentToAnthropic: quickScanUsage,
      detailedAnalyses: detailedAnalysisUsage,
      goodMoments,
      waitingForAi: waitingForAiCount,
    },

    // Cost dashboard — confirmed vs. reserved/in-flight, and the hard
    // kill-switch state. NEVER mixes local ffmpeg/CV processing cost into
    // this (local gates never write an ApiUsage row — see
    // src/analysis/sourceCleanliness.ts / categoryPrefilter.ts).
    budget: {
      paidAiAnalysisEnabled: settings.paidAiAnalysisEnabled,
      confirmedTodayUsd: budget.confirmedTodayUsd,
      reservedInFlightUsd: budget.reservedInFlightUsd,
      remainingUsd: budget.remainingUsd,
      dailyAiBudgetUsd: settings.dailyAiBudgetUsd,
      perRunAiBudgetUsd: settings.perRunAiBudgetUsd,
      callsToday,
      concurrentCallsInFlight: budget.concurrentCallsInFlight,
      quickScanCostUsd,
      detailedAnalysisCostUsd,
      avgCostPerScannedCandidate,
      avgCostPerGoodMoment: avgCostPerGoodClip,
      budgetReached:
        settings.dailyAiBudgetUsd > 0 &&
        budget.confirmedTodayUsd + budget.reservedInFlightUsd >= settings.dailyAiBudgetUsd,
    },
  });
}
