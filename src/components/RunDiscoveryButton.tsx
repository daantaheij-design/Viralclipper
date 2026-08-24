"use client";

import { useState } from "react";

export function RunDiscoveryButton() {
  const [status, setStatus] = useState<"idle" | "starting" | "started">("idle");

  async function run() {
    setStatus("starting");
    await fetch("/api/discovery/run", { method: "POST" });
    setStatus("started");
    setTimeout(() => setStatus("idle"), 4000);
  }

  return (
    <button
      onClick={run}
      disabled={status !== "idle"}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {status === "idle" && "Run discovery now"}
      {status === "starting" && "Starting…"}
      {status === "started" && "Running in background ✓"}
    </button>
  );
}
