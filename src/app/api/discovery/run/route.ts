import { NextResponse } from "next/server";
import { logError } from "@/lib/errorLog";
import { runDiscoveryJob } from "@/jobs/discovery";
import { runAnalysis } from "@/jobs/analysis";
import { runProcessing } from "@/jobs/processing";
import { isLockHeld } from "@/database/jobLock";

export const dynamic = "force-dynamic";

const DISCOVERY_LOCK_NAME = "discovery";
const DISCOVERY_STALE_AFTER_MS = 30 * 60 * 1000;

/** Lets the dashboard reflect the real, DB-backed run state on page load — not just optimistic React state left over from a click. */
export async function GET() {
  const running = await isLockHeld(DISCOVERY_LOCK_NAME, DISCOVERY_STALE_AFTER_MS);
  return NextResponse.json({ running });
}

/**
 * Triggers a manual discover→analyze→render pass. Discovery itself (a
 * bounded number of search-API calls) is awaited so this route can answer
 * `DISCOVERY_ALREADY_RUNNING` synchronously and correctly for a duplicate
 * click — this used to be a pure fire-and-forget call, which is exactly
 * why three rapid clicks on "Run discovery now" could start three
 * overlapping runs (the UI's "Running in background" message was
 * optimistic, not backed by real state). Analysis and rendering (video
 * download, ffmpeg, Anthropic calls — genuinely multi-minute) still run in
 * the background afterward, unchanged.
 */
export async function POST() {
  const discoveryResult = await runDiscoveryJob({ force: true });

  if (discoveryResult.outcome === "already_running") {
    return NextResponse.json({ error: "DISCOVERY_ALREADY_RUNNING" }, { status: 409 });
  }

  void runAnalysisAndProcessing().catch((err) =>
    logError("pipeline", "Manually triggered analysis/processing failed", err),
  );

  return NextResponse.json({ started: true, discovery: discoveryResult });
}

async function runAnalysisAndProcessing(): Promise<void> {
  await runAnalysis();
  await runProcessing();
}
