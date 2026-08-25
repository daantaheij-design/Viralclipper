import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/database/client";
import { storage, storageKeyFor } from "@/storage";
import { AcquisitionError } from "@/video/acquisitionErrors";
import { performRenderAndUpload, type MomentWithVideo, type RenderDependencies } from "./renderCore";

const SCRATCH = path.join("/tmp/viral-clip-finder-test", "render-core");

async function makeMoment(overrides: Partial<{ storageKey: string | null; tikTokStatus: "queued" | "processing" }> = {}) {
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
  const moment = await prisma.detectedMoment.create({
    data: {
      sourceVideoId: sourceVideo.id,
      category: "road_rage",
      title: "Test moment",
      description: "A car brakes suddenly",
      reason: "high conflict",
      startSeconds: 10,
      peakSeconds: 15,
      endSeconds: 25,
      scores: {},
      viralScore: 80,
      confidence: 0.9,
      status: "moment_found",
    },
    include: { sourceVideo: { include: { source: true } } },
  });
  const tikTokVersion = await prisma.tikTokVersion.create({
    data: {
      momentId: moment.id,
      status: overrides.tikTokStatus ?? "processing",
      storageKey: overrides.storageKey,
    },
  });
  return { moment: moment as MomentWithVideo, tikTokVersion };
}

async function cleanup(momentId: string) {
  await prisma.tikTokVersion.deleteMany({ where: { momentId } });
  const moment = await prisma.detectedMoment.findUnique({ where: { id: momentId } });
  await prisma.detectedMoment.deleteMany({ where: { id: momentId } });
  if (moment) await prisma.sourceVideo.deleteMany({ where: { id: moment.sourceVideoId } });
}

/** Fake deps that never touch the network/binaries — only the real local
 * storage backend is exercised for real, so upload+exists coverage is
 * genuine rather than mocked. */
function fakeDeps(overrides: Partial<RenderDependencies> = {}): RenderDependencies {
  return {
    acquireVideo: async (_availability, destDir) => {
      await mkdir(destDir, { recursive: true });
      const filePath = path.join(destDir, "source.mp4");
      writeFileSync(filePath, "fake source bytes");
      return filePath;
    },
    probeVideo: async () => ({
      durationSeconds: 120,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    }),
    renderVerticalClip: async (opts) => {
      await mkdir(path.dirname(opts.outputFilePath), { recursive: true });
      writeFileSync(opts.outputFilePath, "fake rendered bytes");
    },
    uploadToStorage: (key, localPath) => storage.upload(key, localPath),
    verifyStorageObjectExists: (key) => storage.exists(key),
    ...overrides,
  };
}

test("performRenderAndUpload: successful render marks ready only after upload + verification", async () => {
  const { moment, tikTokVersion } = await makeMoment();
  try {
    const result = await performRenderAndUpload(moment, tikTokVersion.id, { deps: fakeDeps() });
    assert.equal(result.outcome, "rendered");

    const storageKey = storageKeyFor(moment.id);
    assert.equal(await storage.exists(storageKey), true);

    const updated = await prisma.tikTokVersion.findUniqueOrThrow({ where: { id: tikTokVersion.id } });
    assert.equal(updated.status, "ready");
    assert.equal(updated.storageKey, storageKey);

    const updatedMoment = await prisma.detectedMoment.findUniqueOrThrow({ where: { id: moment.id } });
    assert.equal(updatedMoment.status, "ready");
  } finally {
    await cleanup(moment.id);
    await rm(SCRATCH, { recursive: true, force: true });
  }
});

test("performRenderAndUpload: bucket upload failure marks failed, never ready", async () => {
  const { moment, tikTokVersion } = await makeMoment();
  try {
    const deps = fakeDeps({
      uploadToStorage: async () => {
        throw new Error("simulated bucket outage");
      },
    });
    const result = await performRenderAndUpload(moment, tikTokVersion.id, { deps });
    assert.equal(result.outcome, "failed");
    assert.match(result.message ?? "", /simulated bucket outage/);

    const updated = await prisma.tikTokVersion.findUniqueOrThrow({ where: { id: tikTokVersion.id } });
    assert.equal(updated.status, "failed");
    assert.notEqual(updated.status, "ready");
  } finally {
    await cleanup(moment.id);
  }
});

test("performRenderAndUpload: upload succeeds but object can't be verified -> media_missing, never ready", async () => {
  const { moment, tikTokVersion } = await makeMoment();
  try {
    const deps = fakeDeps({
      uploadToStorage: async () => ({ sizeBytes: 1234 }),
      verifyStorageObjectExists: async () => false,
    });
    const result = await performRenderAndUpload(moment, tikTokVersion.id, { deps });
    assert.equal(result.outcome, "media_missing");

    const updated = await prisma.tikTokVersion.findUniqueOrThrow({ where: { id: tikTokVersion.id } });
    assert.equal(updated.status, "media_missing");
    assert.notEqual(updated.status, "ready");
    // Moment stays visible on the dashboard even though the render is broken.
    const updatedMoment = await prisma.detectedMoment.findUniqueOrThrow({ where: { id: moment.id } });
    assert.equal(updatedMoment.status, "ready");
  } finally {
    await cleanup(moment.id);
  }
});

test("performRenderAndUpload: ffmpeg render failure marks failed, never ready", async () => {
  const { moment, tikTokVersion } = await makeMoment();
  try {
    const deps = fakeDeps({
      renderVerticalClip: async () => {
        throw new Error("ffmpeg exited with code -9");
      },
    });
    const result = await performRenderAndUpload(moment, tikTokVersion.id, { deps });
    assert.equal(result.outcome, "failed");
    assert.match(result.message ?? "", /ffmpeg exited/);

    const updated = await prisma.tikTokVersion.findUniqueOrThrow({ where: { id: tikTokVersion.id } });
    assert.equal(updated.status, "failed");
  } finally {
    await cleanup(moment.id);
  }
});

test("performRenderAndUpload: source acquisition failure (access-blocked) never re-renders, sets cooldown", async () => {
  const { moment, tikTokVersion } = await makeMoment();
  try {
    const deps = fakeDeps({
      acquireVideo: async () => {
        throw new AcquisitionError({
          kind: "rate_limited",
          message: "YouTube returned HTTP 429",
          isAccessBlocked: true,
        });
      },
    });
    const result = await performRenderAndUpload(moment, tikTokVersion.id, { deps });
    assert.equal(result.outcome, "access_blocked");

    const updatedSourceVideo = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: moment.sourceVideoId } });
    assert.equal(updatedSourceVideo.status, "source_access_blocked");
    assert.ok(updatedSourceVideo.nextRetryAt);

    const updated = await prisma.tikTokVersion.findUniqueOrThrow({ where: { id: tikTokVersion.id } });
    assert.equal(updated.status, "failed");
  } finally {
    await cleanup(moment.id);
  }
});

test("performRenderAndUpload: source acquisition failure (unknown) marks failed without a cooldown", async () => {
  const { moment, tikTokVersion } = await makeMoment();
  try {
    const deps = fakeDeps({
      acquireVideo: async () => {
        throw new AcquisitionError({
          kind: "unknown",
          message: "Video unavailable. This video has been removed by the uploader",
          isAccessBlocked: false,
        });
      },
    });
    const result = await performRenderAndUpload(moment, tikTokVersion.id, { deps });
    assert.equal(result.outcome, "failed");

    const updatedSourceVideo = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: moment.sourceVideoId } });
    assert.notEqual(updatedSourceVideo.status, "source_access_blocked");
  } finally {
    await cleanup(moment.id);
  }
});

test("renderCore.ts never imports the AI/analysis layer — repair never re-runs Claude", () => {
  const src = readFileSync(path.join(import.meta.dirname, "renderCore.ts"), "utf8");
  assert.doesNotMatch(src, /@\/ai\//);
  assert.doesNotMatch(src, /@\/analysis\//);
});
