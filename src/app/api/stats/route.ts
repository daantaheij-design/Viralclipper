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
    pendingLocalFilteringCount,
    filteredOutCount,
    dirtyLeadCount,
    waitingForAiCount,
    aiProcessingCount,
    rejectedByQuickAiCount,
    rejectedByDetailedAiCount,
    rejectedBelowScoreCount,
    aiFailedCount,
    quickScanUsage,
    detailedAnalysisUsage,
    quickScanCostAgg,
    detailedAnalysisCostAgg,
    callsToday,
    videosSentToAnthropicGroups,
  ] = await Promise.all([
    prisma.sourceVideo.count(),
    prisma.sourceVideo.count({ where: { discoveredAt: { gte: since } } }),
    prisma.sourceVideo.count({
      where: {
        status: {
          in: ["scanned", "no_candidates", "ai_rejected_quick", "ai_rejected_detailed", "ai_rejected_below_score", "ai_failed", "error"],
        },
      },
    }),
    prisma.detectedMoment.count({ where: { viralScore: { gte: settings.minViralScore } } }),
    prisma.tikTokVersion.count({ where: { status: "ready" } }),
    prisma.apiUsage.aggregate({ where: { provider: "anthropic" }, _sum: { costUsd: true } }),
    prisma.discoveryRun.findFirst({ orderBy: { startedAt: "desc" } }),
    // Not yet through the free local stage (acquisition + cleanliness scan)
    // — this is what src/jobs/analysis.ts's free batch drains, independent
    // of maxQuickScansPerRun. See "Pending local filtering" on the funnel.
    prisma.sourceVideo.count({ where: { status: { in: ["discovered", "queued_for_scan", "source_access_blocked"] } } }),
    prisma.sourceVideo.count({ where: { status: "filtered_out" } }),
    prisma.sourceVideo.count({ where: { status: "dirty_lead" } }),
    // Passed every free/local gate and is parked, ready for a paid quick
    // scan whenever Paid AI Analysis is on — the canonical "clean
    // candidate" bucket (see src/jobs/analysis.ts's free stage). Queries
    // ONLY status = waiting_for_ai, nothing else — verified against the
    // production incident where this looked "stuck" at ~56 (it wasn't a
    // counting bug: the free batch can add up to freeLocalFilterBatchSize
    // new candidates per tick while the paid batch removes at most
    // maxQuickScansPerRun, so net movement can look flat even while paid
    // processing is really happening — see aiProcessing/rejectedBy*/
    // aiFailures below for that visibility instead).
    prisma.sourceVideo.count({ where: { status: "waiting_for_ai" } }),
    prisma.sourceVideo.count({ where: { status: "ai_processing" } }),
    prisma.sourceVideo.count({ where: { status: "ai_rejected_quick" } }),
    prisma.sourceVideo.count({ where: { status: "ai_rejected_detailed" } }),
    prisma.sourceVideo.count({ where: { status: "ai_rejected_below_score" } }),
    prisma.sourceVideo.count({ where: { status: "ai_failed" } }),
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
    // Distinct source videos that have ever had at least one real Anthropic
    // request — deliberately different from "Anthropic API requests"
    // (quickScanUsage + detailedAnalysisUsage) below: one video's quick
    // scan alone can span multiple 40-frame batches (multiple requests),
    // and a video that gets both a quick scan and a detailed analysis
    // contributes 2+ requests but is still exactly 1 video. Conflating
    // these two numbers is part of what made the production dashboard's
    // "Sent to Anthropic: 12 -> 14" reading ambiguous.
    prisma.apiUsage.groupBy({ by: ["sourceVideoId"], where: { provider: "anthropic", sourceVideoId: { not: null } } }),
  ]);

  const totalCostUsd = totalCostAgg._sum.costUsd ?? 0;
  const avgCostPerGoodClip = goodMoments > 0 ? totalCostUsd / goodMoments : 0;
  const avgCostPerScannedCandidate = quickScanUsage > 0 ? totalCostUsd / quickScanUsage : 0;
  const quickScanCostUsd = quickScanCostAgg._sum.costUsd ?? 0;
  const detailedAnalysisCostUsd = detailedAnalysisCostAgg._sum.costUsd ?? 0;
  const anthropicApiRequests = quickScanUsage + detailedAnalysisUsage;
  const videosSentToAnthropic = videosSentToAnthropicGroups.length;

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
    // AND after Anthropic cost is incurred. All real database status
    // counts, not client-side estimates or in-memory worker-tick
    // accumulation. See README's "Cost control" section.
    funnel: {
      videosDiscovered,
      rejectedByMetadata: lastDiscoveryRun?.duplicatesSkipped ?? 0,
      rejectedWrongCategory: filteredOutCount,
      rejectedDirtySource: dirtyLeadCount,
      pendingLocalFiltering: pendingLocalFilteringCount,
      cleanCandidates: waitingForAiCount,
      waitingForAi: waitingForAiCount,
      aiProcessing: aiProcessingCount,
      rejectedByQuickAi: rejectedByQuickAiCount,
      rejectedByDetailedAi: rejectedByDetailedAiCount,
      rejectedBelowScore: rejectedBelowScoreCount,
      aiFailures: aiFailedCount,
      // Two deliberately distinct numbers — see the groupBy query above's
      // comment for why they can differ (one video, multiple requests).
      videosSentToAnthropic,
      anthropicApiRequests,
      detailedAnalyses: detailedAnalysisUsage,
      goodMoments,
      actualCostTodayUsd: budget.confirmedTodayUsd,
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
