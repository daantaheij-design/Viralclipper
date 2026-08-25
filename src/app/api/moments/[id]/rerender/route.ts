import { NextResponse } from "next/server";
import { repairRender } from "@/jobs/rerender";

/**
 * Rebuilds and re-uploads one moment's 9:16 clip — reuses the existing
 * analysis (timestamps, category, score, tracked keyframes), no Claude
 * calls. Awaited: a single clip render is bounded (one download + one
 * ffmpeg pass + one upload), unlike a full discovery/analysis run, so the
 * caller gets the real outcome back directly instead of having to poll.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await repairRender(id);

  if (result.outcome === "not_found") {
    return NextResponse.json({ error: "Moment not found" }, { status: 404 });
  }

  return NextResponse.json({ result });
}
