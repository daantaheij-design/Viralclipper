import { NextResponse } from "next/server";
import { prisma } from "@/database/client";

/** Queues the moment's source video for another analysis pass on the next worker tick. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const moment = await prisma.detectedMoment.findUnique({ where: { id } });
  if (!moment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.sourceVideo.update({
    where: { id: moment.sourceVideoId },
    data: { status: "queued_for_scan", errorMessage: null },
  });

  return NextResponse.json({ ok: true });
}
