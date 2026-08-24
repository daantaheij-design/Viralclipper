import { NextResponse } from "next/server";
import { logError } from "@/lib/errorLog";
import { runFullPipeline } from "@/jobs/pipeline";

/**
 * Kicks off one full discover→analyze→render pass in the background and
 * returns immediately — this route is meant to be called from the
 * dashboard's "Run discovery now" button, not waited on (a full pass can
 * take many minutes). The `worker` process runs the same pipeline on its
 * own schedule regardless of whether this is ever called.
 */
export async function POST() {
  void runFullPipeline({ forceDiscovery: true }).catch((err) =>
    logError("pipeline", "Manually triggered pipeline run failed", err),
  );
  return NextResponse.json({ started: true });
}
