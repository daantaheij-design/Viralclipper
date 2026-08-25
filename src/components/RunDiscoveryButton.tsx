"use client";

import { useEffect, useState } from "react";

export function RunDiscoveryButton() {
  // Reflects the DB-backed discovery lock (GET /api/discovery/run), not
  // just local optimism — checked on mount so a page reload shows the real
  // state, not a misleadingly-idle button, if a run is already active
  // (e.g. started by the worker, or from another browser tab).
  const [running, setRunning] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState(false);

  useEffect(() => {
    fetch("/api/discovery/run", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRunning(Boolean(d.running)))
      .catch(() => {});
  }, []);

  async function run() {
    setRunning(true);
    setBlockedMessage(false);
    let wasBlocked = false;
    try {
      // The route awaits discovery itself (a bounded number of search-API
      // calls) before responding, so this request being in flight IS the
      // real "discovery running" state — a second click while this is
      // pending hits the disabled button below; a click from another
      // tab/the worker instead gets a 409 here.
      const res = await fetch("/api/discovery/run", { method: "POST" });
      wasBlocked = res.status === 409;
    } finally {
      setRunning(false);
      if (wasBlocked) {
        setBlockedMessage(true);
        setTimeout(() => setBlockedMessage(false), 4000);
      }
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={running}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running ? "Discovery running…" : "Run discovery now"}
      </button>
      {blockedMessage && (
        <span className="text-xs text-muted">A discovery run was already active — nothing new started.</span>
      )}
    </div>
  );
}
