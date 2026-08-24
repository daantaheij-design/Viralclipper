"use client";

import { useEffect, useState } from "react";
import { SOURCE_LABELS } from "@/lib/format";
import type { SourceName } from "@/generated/prisma";

interface SourceRow {
  id: string;
  name: SourceName;
  enabled: boolean;
  _count: { sourceVideos: number; searchQueries: number };
}

export function SourcesPanel() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);

  async function load() {
    const res = await fetch("/api/sources", { cache: "no-store" });
    const data = await res.json();
    setSources(data.sources);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount is the intended pattern here
    void load();
  }, []);

  async function toggle(name: SourceName, enabled: boolean) {
    setSources((prev) => prev?.map((s) => (s.name === name ? { ...s, enabled } : s)) ?? null);
    await fetch("/api/sources", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    });
  }

  if (!sources) return <div className="text-muted">Loading…</div>;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {sources.map((source) => (
        <div key={source.id} className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">{SOURCE_LABELS[source.name]}</h3>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={source.enabled}
                onChange={(e) => toggle(source.name, e.target.checked)}
                className="peer sr-only"
              />
              <div className="h-6 w-11 rounded-full bg-neutral-700 transition peer-checked:bg-accent" />
              <div className="absolute left-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-5" />
            </label>
          </div>
          <p className="mt-2 text-sm text-muted">
            {source._count.sourceVideos.toLocaleString()} videos discovered ·{" "}
            {source._count.searchQueries.toLocaleString()} search queries
          </p>
          <p className="mt-1 text-xs text-muted">
            {source.enabled ? "Included in the next discovery run." : "Skipped until re-enabled."}
          </p>
        </div>
      ))}
    </div>
  );
}
