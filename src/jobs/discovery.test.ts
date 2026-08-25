import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/database/client";
import { updateSettings } from "@/database/settings";
import { runDiscoveryJob } from "./discovery";

test("runDiscoveryJob: not forced and automatic discovery disabled -> outcome 'disabled', no run created", async () => {
  await updateSettings({ automaticDiscoveryEnabled: false });
  const before = await prisma.discoveryRun.count();

  const result = await runDiscoveryJob();
  assert.deepEqual(result, { outcome: "disabled" });

  const after = await prisma.discoveryRun.count();
  assert.equal(after, before);
});

test("runDiscoveryJob: three simultaneous forced calls -> exactly one completes, the other two are DISCOVERY_ALREADY_RUNNING", async () => {
  // Mirrors the production bug this PR fixes: clicking "Run discovery now"
  // three times used to start three overlapping runs. runDiscovery()
  // itself catches its own errors (no real YOUTUBE_API_KEY in this
  // sandbox is fine — it just means the run completes with 0 results,
  // exercised for real), so this is a genuine concurrency test of the
  // DB-backed lock, not a mock.
  const attempts = [runDiscoveryJob({ force: true }), runDiscoveryJob({ force: true }), runDiscoveryJob({ force: true })];
  const results = await Promise.all(attempts);

  const completed = results.filter((r) => r.outcome === "completed");
  const alreadyRunning = results.filter((r) => r.outcome === "already_running");

  assert.equal(completed.length, 1, `expected exactly 1 completed run, got ${completed.length}`);
  assert.equal(alreadyRunning.length, 2, `expected exactly 2 already_running responses, got ${alreadyRunning.length}`);
});
