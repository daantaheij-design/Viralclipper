import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { prisma } from "@/database/client";
import { storage, storageKeyFor } from "@/storage";
import { GET } from "./route";

async function makeMoment() {
  const source = await prisma.source.upsert({
    where: { name: "youtube" },
    create: { name: "youtube" },
    update: {},
  });
  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      sourceId: source.id,
      sourceVideoId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url: "https://www.youtube.com/watch?v=test",
      title: "Test video",
      category: "road_rage",
    },
  });
  return prisma.detectedMoment.create({
    data: {
      sourceVideoId: sourceVideo.id,
      category: "road_rage",
      title: "Test moment",
      description: "desc",
      reason: "reason",
      startSeconds: 0,
      peakSeconds: 1,
      endSeconds: 5,
      scores: {},
      viralScore: 80,
      confidence: 0.9,
      status: "ready",
    },
  });
}

async function cleanup(momentId: string) {
  const moment = await prisma.detectedMoment.findUnique({ where: { id: momentId } });
  await prisma.tikTokVersion.deleteMany({ where: { momentId } });
  await prisma.detectedMoment.deleteMany({ where: { id: momentId } });
  if (moment) await prisma.sourceVideo.deleteMany({ where: { id: moment.sourceVideoId } });
}

test("GET /api/media/[momentId]: status ready but object missing on disk -> 404, never hangs", async () => {
  const moment = await makeMoment();
  const storageKey = storageKeyFor(moment.id);
  await prisma.tikTokVersion.create({
    data: { momentId: moment.id, status: "ready", storageKey },
  });
  try {
    assert.equal(await storage.exists(storageKey), false);
    const res = await GET(new NextRequest(`http://localhost/api/media/${moment.id}`), {
      params: Promise.resolve({ momentId: moment.id }),
    });
    assert.equal(res.status, 404);
  } finally {
    await cleanup(moment.id);
  }
});

test("GET /api/media/[momentId]: status media_missing -> 404 without ever attempting to resolve storage", async () => {
  const moment = await makeMoment();
  await prisma.tikTokVersion.create({
    data: { momentId: moment.id, status: "media_missing", storageKey: storageKeyFor(moment.id), errorMessage: "gone" },
  });
  try {
    const res = await GET(new NextRequest(`http://localhost/api/media/${moment.id}`), {
      params: Promise.resolve({ momentId: moment.id }),
    });
    assert.equal(res.status, 404);
  } finally {
    await cleanup(moment.id);
  }
});

test("GET /api/media/[momentId]: object genuinely exists -> 200 and streams it", async () => {
  const moment = await makeMoment();
  const storageKey = storageKeyFor(moment.id);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  const { env } = await import("@/lib/env");
  mkdirSync(path.dirname(path.join(env.storageDir, storageKey)), { recursive: true });
  writeFileSync(path.join(env.storageDir, storageKey), "fake mp4 bytes");
  await prisma.tikTokVersion.create({
    data: { momentId: moment.id, status: "ready", storageKey },
  });
  try {
    const res = await GET(new NextRequest(`http://localhost/api/media/${moment.id}`), {
      params: Promise.resolve({ momentId: moment.id }),
    });
    assert.equal(res.status, 200);
  } finally {
    await cleanup(moment.id);
  }
});
