"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CATEGORY_LABELS, SOURCE_LABELS } from "@/lib/format";
import { ClipCard } from "./ClipCard";
import { VerticalPlayer } from "./VerticalPlayer";
import { RunDiscoveryButton } from "./RunDiscoveryButton";
import type { MomentWithRelations } from "./types";
import type { MomentAction, MomentView, SortBy } from "@/database/moments";
import type { RerenderOutcome } from "@/lib/playerState";

const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS) as [string, string][];
const SOURCE_OPTIONS = Object.entries(SOURCE_LABELS) as [string, string][];

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "viral_score", label: "Highest Viral Score" },
  { value: "newest", label: "Newest" },
  { value: "most_viewed", label: "Most Viewed" },
  { value: "recently_discovered", label: "Recently Discovered" },
  { value: "highest_confidence", label: "Highest Confidence" },
  { value: "shortest", label: "Shortest" },
  { value: "longest", label: "Longest" },
];

interface MomentFeedProps {
  view: MomentView;
  heading: string;
  subheading?: string;
  emptyMessage: string;
  defaultSortBy?: SortBy;
  showSinceFilter?: boolean;
  bigNumberBanner?: boolean;
}

export function MomentFeed({
  view,
  heading,
  subheading,
  emptyMessage,
  defaultSortBy = "viral_score",
  showSinceFilter = false,
  bigNumberBanner = false,
}: MomentFeedProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [category, setCategory] = useState(searchParams.get("category") ?? "");
  const [source, setSource] = useState(searchParams.get("source") ?? "");
  const [minScore, setMinScore] = useState(searchParams.get("minScore") ?? "");
  const [sortBy, setSortBy] = useState<SortBy>((searchParams.get("sortBy") as SortBy) ?? defaultSortBy);
  const [since, setSince] = useState(searchParams.get("since") ?? "");
  const [tiktokReady, setTiktokReady] = useState(searchParams.get("tiktokReady") === "1");

  const [moments, setMoments] = useState<MomentWithRelations[] | null>(null);
  const [previewMoment, setPreviewMoment] = useState<MomentWithRelations | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ view, sortBy });
    if (category) params.set("category", category);
    if (source) params.set("source", source);
    if (minScore) params.set("minScore", minScore);
    if (since) params.set("since", since);
    if (tiktokReady) params.set("tiktokReady", "1");
    return params.toString();
  }, [view, category, source, minScore, sortBy, since, tiktokReady]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/moments?${queryString}`, { cache: "no-store" });
    const data = await res.json();
    setMoments(data.moments);
  }, [queryString]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-side fetch-on-filter-change is the intended pattern here
    void load();
    router.replace(`?${queryString}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  async function handleAction(id: string, action: MomentAction) {
    await fetch(`/api/moments/${id}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setMoments((prev) => prev?.filter((m) => m.id !== id) ?? null);
  }

  async function handleReanalyze(id: string) {
    await fetch(`/api/moments/${id}/reanalyze`, { method: "POST" });
  }

  async function handleRerender(id: string): Promise<RerenderOutcome> {
    const res = await fetch(`/api/moments/${id}/rerender`, { method: "POST" });
    const data = await res.json();

    // Refresh this one moment from the server (rather than the whole list)
    // so the card/player reflect the real post-repair state — including a
    // fresh storage key and, via getMomentById's own self-check, an
    // accurate status — without reshuffling the list's current filter/sort.
    const refreshed = await fetch(`/api/moments/${id}`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null);
    if (refreshed?.moment) {
      setMoments((prev) => prev?.map((m) => (m.id === id ? refreshed.moment : m)) ?? null);
    }

    return res.ok ? data.result : { outcome: "failed", message: data.error ?? "Re-render request failed" };
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {bigNumberBanner ? (
            <>
              <h1 className="text-4xl font-extrabold tracking-tight text-foreground">
                {moments ? moments.length : "…"}{" "}
                <span className="text-accent">NEW MOMENTS FOUND</span>
              </h1>
              <p className="mt-1 text-sm text-muted">{subheading ?? heading}</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-foreground">{heading}</h1>
              <p className="mt-1 text-sm text-muted">
                {subheading ?? (moments ? `${moments.length} clip${moments.length === 1 ? "" : "s"}` : "Loading…")}
              </p>
            </>
          )}
        </div>
        <RunDiscoveryButton />
      </div>

      <div className="mb-6 flex flex-wrap gap-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          <option value="">All Categories</option>
          {CATEGORY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          <option value="">All Sources</option>
          {SOURCE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {showSinceFilter && (
          <select
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="">All Time</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
          </select>
        )}

        <input
          type="number"
          min={0}
          max={100}
          placeholder="Min score"
          value={minScore}
          onChange={(e) => setMinScore(e.target.value)}
          className="w-28 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />

        <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={tiktokReady}
            onChange={(e) => setTiktokReady(e.target.checked)}
          />
          9:16 ready only
        </label>
      </div>

      {moments === null ? (
        <div className="py-24 text-center text-muted">Loading…</div>
      ) : moments.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-24 text-center text-muted">
          {emptyMessage}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {moments.map((moment) => (
            <ClipCard
              key={moment.id}
              moment={moment}
              view={view}
              onPreview={setPreviewMoment}
              onAction={handleAction}
              onReanalyze={handleReanalyze}
              onRerender={handleRerender}
            />
          ))}
        </div>
      )}

      {previewMoment && (
        <VerticalPlayer
          moment={previewMoment}
          onClose={() => setPreviewMoment(null)}
          onRerender={handleRerender}
        />
      )}
    </div>
  );
}
