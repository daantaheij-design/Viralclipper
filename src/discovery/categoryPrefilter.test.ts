import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { computeCategoryPrefilter } from "./categoryPrefilter";
import type { DiscoveredVideo } from "@/sources/types";

function video(overrides: Partial<DiscoveredVideo> = {}): DiscoveredVideo {
  return {
    sourceVideoId: "abc123",
    url: "https://example.com/abc123",
    title: "",
    description: "",
    ...overrides,
  };
}

test("computeCategoryPrefilter: on-topic road_rage title scores well above the 70 threshold", () => {
  const result = computeCategoryPrefilter(
    video({ title: "Insane Road Rage Brake Check Instant Karma", description: "Dashcam catches aggressive driver" }),
    "road_rage",
  );
  assert.ok(result.score >= 70, `expected >= 70, got ${result.score}: ${result.reason}`);
});

test("computeCategoryPrefilter: obviously wrong category (gaming) is rejected regardless of target category", () => {
  const result = computeCategoryPrefilter(
    video({ title: "Insane Minecraft Gameplay Speedrun Highlights", description: "Full Let's Play video game session" }),
    "road_rage",
  );
  assert.ok(result.score < 70, `expected < 70, got ${result.score}: ${result.reason}`);
  assert.match(result.reason, /unrelated-topic phrase/);
});

test("computeCategoryPrefilter: aviation argument is rejected for road_rage", () => {
  const result = computeCategoryPrefilter(
    video({ title: "Pilot Argument With Air Traffic Control", description: "Cockpit recording of a heated exchange" }),
    "road_rage",
  );
  assert.ok(result.score < 70, `expected < 70, got ${result.score}`);
});

test("computeCategoryPrefilter: courtroom footage is rejected for confrontations", () => {
  const result = computeCategoryPrefilter(
    video({ title: "Judge Judy Courtroom Footage Verdict", description: "Small claims court trial" }),
    "confrontations",
  );
  assert.ok(result.score < 70, `expected < 70, got ${result.score}`);
});

test("computeCategoryPrefilter: workplace/customer-service argument is rejected for arguments", () => {
  const result = computeCategoryPrefilter(
    video({ title: "Karen At Work Customer Service Call Meltdown", description: "Office argument HR complaint" }),
    "arguments",
  );
  assert.ok(result.score < 70, `expected < 70, got ${result.score}`);
});

test("computeCategoryPrefilter: vague/unrelated title (no keyword hits, no blocklist hit) scores low but isn't misreported as blocklisted", () => {
  const result = computeCategoryPrefilter(video({ title: "A Video", description: "" }), "road_rage");
  assert.equal(result.score, 0);
  assert.doesNotMatch(result.reason, /unrelated-topic phrase/);
});

test("categoryPrefilter.ts never imports the Anthropic/AI layer — the category gate is zero-Anthropic", async () => {
  const src = await readFile(new URL("./categoryPrefilter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["']@\/ai\//);
});
