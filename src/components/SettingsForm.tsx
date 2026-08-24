"use client";

import { useEffect, useState } from "react";
import { CATEGORY_LABELS } from "@/lib/format";
import type { DiscoverySettings } from "@/database/settings";
import type { Category } from "@/generated/prisma";

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

export function SettingsForm() {
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSettings(d.settings));
  }, []);

  async function save(next: DiscoverySettings) {
    setSettings(next);
    setSaving(true);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    setSaving(false);
    setSaved(true);
  }

  function toggleCategory(category: Category) {
    if (!settings) return;
    const enabled = settings.enabledCategories.includes(category)
      ? settings.enabledCategories.filter((c) => c !== category)
      : [...settings.enabledCategories, category];
    void save({ ...settings, enabledCategories: enabled });
  }

  if (!settings) return <div className="text-muted">Loading…</div>;

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-foreground">Automatic discovery</h2>
            <p className="text-sm text-muted">Run discovery on a schedule in the background.</p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={settings.automaticDiscoveryEnabled}
              onChange={(e) => save({ ...settings, automaticDiscoveryEnabled: e.target.checked })}
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-neutral-700 transition peer-checked:bg-accent" />
            <div className="absolute left-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-5" />
          </label>
        </div>

        <label className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted">Discovery frequency (hours)</span>
          <input
            type="number"
            min={1}
            value={settings.discoveryFrequencyHours}
            onChange={(e) => save({ ...settings, discoveryFrequencyHours: Number(e.target.value) })}
            className="w-24 rounded-lg border border-border bg-surface px-2 py-1 text-right"
          />
        </label>
      </section>

      <section>
        <h2 className="font-semibold text-foreground">Categories</h2>
        <p className="text-sm text-muted">Only enabled categories are searched for.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ALL_CATEGORIES.map((category) => (
            <label
              key={category}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={settings.enabledCategories.includes(category)}
                onChange={() => toggleCategory(category)}
              />
              {CATEGORY_LABELS[category]}
            </label>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          label="Minimum viral score"
          value={settings.minViralScore}
          onChange={(v) => save({ ...settings, minViralScore: v })}
          min={0}
          max={100}
        />
        <NumberField
          label="Candidates per run"
          value={settings.candidatesPerRun}
          onChange={(v) => save({ ...settings, candidatesPerRun: v })}
          min={1}
        />
        <NumberField
          label="Max quick scans per run"
          value={settings.maxQuickScansPerRun}
          onChange={(v) => save({ ...settings, maxQuickScansPerRun: v })}
          min={0}
        />
        <NumberField
          label="Max detailed analyses per run"
          value={settings.maxDetailedAnalysesPerRun}
          onChange={(v) => save({ ...settings, maxDetailedAnalysesPerRun: v })}
          min={0}
        />
        <NumberField
          label="Daily AI budget (USD, 0 = no cap)"
          value={settings.dailyAiBudgetUsd}
          onChange={(v) => save({ ...settings, dailyAiBudgetUsd: v })}
          min={0}
          step={0.5}
        />
      </section>

      <p className="text-xs text-muted">{saving ? "Saving…" : saved ? "Saved." : ""}</p>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-right"
      />
    </label>
  );
}
