import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/database/client";
import { absolutePathFor } from "@/storage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ momentId: string }> }) {
  const { momentId } = await context.params;

  const tikTokVersion = await prisma.tikTokVersion.findUnique({ where: { momentId } });
  if (!tikTokVersion || tikTokVersion.status !== "ready" || !tikTokVersion.storageKey) {
    return NextResponse.json({ error: "Not ready" }, { status: 404 });
  }

  const filePath = absolutePathFor(tikTokVersion.storageKey);
  const stats = await stat(filePath).catch(() => null);
  if (!stats) return NextResponse.json({ error: "File missing" }, { status: 404 });

  const range = request.headers.get("range");
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : stats.size - 1;
    const chunkSize = end - start + 1;

    headers.set("Content-Range", `bytes ${start}-${end}/${stats.size}`);
    headers.set("Content-Length", String(chunkSize));

    const stream = createReadStream(filePath, { start, end });
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers,
    });
  }

  headers.set("Content-Length", String(stats.size));
  const stream = createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}
