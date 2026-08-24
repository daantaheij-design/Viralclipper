import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/database/client";
import type { SourceName } from "@/generated/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const sources = await prisma.source.findMany({
    include: { _count: { select: { sourceVideos: true, searchQueries: true } } },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ sources });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json()) as { name: SourceName; enabled: boolean };
  const source = await prisma.source.update({
    where: { name: body.name },
    data: { enabled: body.enabled },
  });
  return NextResponse.json({ source });
}
