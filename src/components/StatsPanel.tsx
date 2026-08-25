"use client";

import { useEffect, useState } from "react";
import { formatCompactNumber, formatUsd } from "@/lib/format";

interface Stats {
  videosDiscovered: number;
  videosDiscoveredToday: number;
  videosScanned: number;
  goodMoments: number;
  clipsReady: number;
  totalCostUsd: number;
  aiCostTodayUsd: number;
  avgCostPerGoodClip: number;
  dailyAiBudgetUsd: number;
  lastDiscoveryRun: { status: string; startedAt: string; finishedAt: string | null } | null;
  funnel: {
    videosDiscovered: number;
    rejectedByMetadata: number;
    rejectedWrongCategory: number;
    rejectedDirtySource: number;
    pendingLocalFiltering: number;
    cleanCandidates: number;
    sentToAnthropic: number;
    detailedAnalyses: number;
    goodMoments: number;
    waitingForAi: number;
  };
  budget: {
    paidAiAnalysisEnabled: boolean;
    confirmedTodayUsd: number;
    reservedInFlightUsd: number;
    remainingUsd: number;
    dailyAiBudgetUsd: number;
    perRunAiBudgetUsd: number;
    callsToday: number;
    concurrentCallsInFlight: number;
    quickScanCostUsd: number;
    detailedAnalysisCostUsd: number;
    avgCostPerScannedCandidate: number;
    avgCostPerGoodMoment: number;
    budgetReached: boolean;
  };
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}

function FunnelRow({ label, value, dim }: { label: string; value: number; dim?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-2 text-sm last:border-0">
      <span className={dim ? "text-muted" : "text-foreground"}>{label}</span>
      <span className={`font-mono font-medium ${dim ? "text-muted" : "text-foreground"}`}>
        {formatCompactNumber(value)}
      </span>
    </div>
  );
}

export function StatsPanel() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then(setStats);
  }, []);

  if (!stats) return <div className="text-muted">Loading…</div>;

  const budgetUsed =
    stats.budget.dailyAiBudgetUsd > 0
      ? Math.min((stats.budget.confirmedTodayUsd + stats.budget.reservedInFlightUsd) / stats.budget.dailyAiBudgetUsd, 1)
      : 0;

  return (
    <div className="space-y-6">
      {!stats.budget.paidAiAnalysisEnabled && (
        <div className="rounded-xl border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          <strong>Paid AI Analysis is OFF.</strong> No Anthropic calls will happen anywhere in the app
          (worker, manual discovery, retries, repairs). Local discovery and free filtering continue
          normally. Turn it on from Settings when you&rsquo;re ready to spend.
        </div>
      )}
      {stats.budget.paidAiAnalysisEnabled && stats.budget.budgetReached && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm font-semibold text-red-300">
          AI BUDGET REACHED — PAID ANALYSIS PAUSED. No more Anthropic calls will happen until the
          daily budget resets or you raise it in Settings.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Videos discovered" value={formatCompactNumber(stats.videosDiscovered)} />
        <Tile label="Videos scanned" value={formatCompactNumber(stats.videosScanned)} />
        <Tile label="Good moments" value={formatCompactNumber(stats.goodMoments)} />
        <Tile label="9:16 clips created" value={formatCompactNumber(stats.clipsReady)} />
        <Tile label="AI cost today" value={formatUsd(stats.budget.confirmedTodayUsd)} />
        <Tile label="Avg cost / good moment" value={formatUsd(stats.budget.avgCostPerGoodMoment)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Discovery funnel</h3>
          <FunnelRow label="Videos discovered" value={stats.funnel.videosDiscovered} />
          <FunnelRow label="Rejected by metadata (dedup)" value={stats.funnel.rejectedByMetadata} dim />
          <FunnelRow label="Rejected — wrong category" value={stats.funnel.rejectedWrongCategory} dim />
          <FunnelRow label="Rejected — dirty source" value={stats.funnel.rejectedDirtySource} dim />
          <FunnelRow label="Pending local filtering" value={stats.funnel.pendingLocalFiltering} dim />
          <FunnelRow label="Clean candidates / waiting for AI" value={stats.funnel.cleanCandidates} />
          <FunnelRow label="Sent to Anthropic (quick scans)" value={stats.funnel.sentToAnthropic} />
          <FunnelRow label="Detailed analyses" value={stats.funnel.detailedAnalyses} />
          <FunnelRow label="Good moments" value={stats.funnel.goodMoments} />
          <p className="mt-2 border-t border-border/50 pt-2 text-[11px] text-muted">
            &ldquo;Pending local filtering&rdquo; is the free backlog (acquisition + cleanliness scan,
            zero Anthropic cost) — each worker tick drains up to your Free local filter batch size
            from it. &ldquo;Clean candidates / waiting for AI&rdquo; is parked and ready; it only
            moves to &ldquo;Sent to Anthropic&rdquo; once Paid AI Analysis is on, one batch of
            Max quick scans per run at a time.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">AI spend</h3>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Daily AI budget</span>
            <span className="font-medium">
              {formatUsd(stats.budget.confirmedTodayUsd)} confirmed
              {stats.budget.reservedInFlightUsd > 0 && ` + ${formatUsd(stats.budget.reservedInFlightUsd)} reserved`} /{" "}
              {formatUsd(stats.budget.dailyAiBudgetUsd)}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full ${budgetUsed >= 1 ? "bg-red-500" : "bg-accent"}`}
              style={{ width: `${budgetUsed * 100}%` }}
            />
          </div>
          <div className="mt-3 space-y-1 text-xs text-muted">
            <div className="flex justify-between">
              <span>Remaining today</span>
              <span className="font-mono">{formatUsd(stats.budget.remainingUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span>Calls today</span>
              <span className="font-mono">{stats.budget.callsToday}</span>
            </div>
            <div className="flex justify-between">
              <span>Concurrent calls in flight</span>
              <span className="font-mono">{stats.budget.concurrentCallsInFlight}</span>
            </div>
            <div className="flex justify-between">
              <span>Quick scan cost (all time)</span>
              <span className="font-mono">{formatUsd(stats.budget.quickScanCostUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span>Detailed analysis cost (all time)</span>
              <span className="font-mono">{formatUsd(stats.budget.detailedAnalysisCostUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span>Avg cost / scanned candidate</span>
              <span className="font-mono">{formatUsd(stats.budget.avgCostPerScannedCandidate)}</span>
            </div>
          </div>
          <p className="mt-3 border-t border-border/50 pt-2 text-[11px] text-muted">
            Local processing (ffmpeg source-cleanliness scan, metadata/category prefilter) is free —
            never counted toward AI spend above. It runs whether or not Paid AI Analysis is on.
          </p>
        </div>
      </div>

      {stats.lastDiscoveryRun && (
        <p className="text-xs text-muted">
          Last discovery run: {stats.lastDiscoveryRun.status} at{" "}
          {new Date(stats.lastDiscoveryRun.startedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
