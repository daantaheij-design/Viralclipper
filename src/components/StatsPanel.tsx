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
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
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
    stats.dailyAiBudgetUsd > 0 ? Math.min(stats.aiCostTodayUsd / stats.dailyAiBudgetUsd, 1) : 0;

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Videos discovered" value={formatCompactNumber(stats.videosDiscovered)} />
        <Tile label="Videos scanned" value={formatCompactNumber(stats.videosScanned)} />
        <Tile label="Good moments" value={formatCompactNumber(stats.goodMoments)} />
        <Tile label="9:16 clips created" value={formatCompactNumber(stats.clipsReady)} />
        <Tile label="AI cost today" value={formatUsd(stats.aiCostTodayUsd)} />
        <Tile label="Avg cost / good clip" value={formatUsd(stats.avgCostPerGoodClip)} />
      </div>

      {stats.dailyAiBudgetUsd > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Daily AI budget</span>
            <span className="font-medium">
              {formatUsd(stats.aiCostTodayUsd)} / {formatUsd(stats.dailyAiBudgetUsd)}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full ${budgetUsed >= 1 ? "bg-red-500" : "bg-accent"}`}
              style={{ width: `${budgetUsed * 100}%` }}
            />
          </div>
        </div>
      )}

      {stats.lastDiscoveryRun && (
        <p className="mt-4 text-xs text-muted">
          Last discovery run: {stats.lastDiscoveryRun.status} at{" "}
          {new Date(stats.lastDiscoveryRun.startedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
