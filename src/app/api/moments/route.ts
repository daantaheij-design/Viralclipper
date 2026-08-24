import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listMoments, type MomentFilters, type MomentView, type SortBy } from "@/database/moments";
import type { Category, SourceName } from "@/generated/prisma";

export const dynamic = "force-dynamic";

function asNumber(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const filters: MomentFilters = {
    view: (sp.get("view") as MomentView | null) ?? "discover",
    category: (sp.get("category") as Category | null) ?? undefined,
    source: (sp.get("source") as SourceName | null) ?? undefined,
    minScore: asNumber(sp.get("minScore")),
    minDurationSeconds: asNumber(sp.get("minDuration")),
    maxDurationSeconds: asNumber(sp.get("maxDuration")),
    maxUploadAgeDays: asNumber(sp.get("maxUploadAgeDays")),
    tiktokReadyOnly: sp.get("tiktokReady") === "1",
    sortBy: (sp.get("sortBy") as SortBy | null) ?? undefined,
    limit: asNumber(sp.get("limit")),
  };

  const since = sp.get("since");
  if (since === "today") {
    filters.since = new Date(new Date().setUTCHours(0, 0, 0, 0));
  } else if (since === "week") {
    filters.since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  const moments = await listMoments(filters);
  return NextResponse.json({ moments });
}
