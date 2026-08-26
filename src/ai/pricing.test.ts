import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, estimateMaxCostUsd } from "./pricing";

/**
 * Pure-function tests for the pre-call cost estimate — no DB, no network.
 * This is the direct fix for the production incident where a flat
 * "1600 tokens/image" estimate undershot the real cost of native-resolution
 * (1080p+) frames, letting confirmed spend land above the configured daily
 * budget even though every individual reservation looked "within budget" at
 * approval time. See pricing.ts's module doc comment for the full story.
 */

test("estimateMaxCostUsd: a 1080p frame set estimates well above the old flat 1600-tokens/image assumption", () => {
  const model = "claude-opus-5";
  const frameCount = 40; // one quickScan.ts batch (FRAMES_PER_BATCH)
  const maxTokens = 4000;

  // What the OLD flat estimate would have produced (1600 tokens/image, no
  // safety margin, no per-request overhead) — this is exactly the shape of
  // estimate that under-reserved budget in production.
  const oldFlatEstimate = estimateCostUsd(model, frameCount * 1600, maxTokens);

  const newEstimate = estimateMaxCostUsd(model, frameCount, maxTokens, { width: 1920, height: 1080 });

  assert.ok(
    newEstimate > oldFlatEstimate,
    `expected the real-dimension estimate ($${newEstimate}) to exceed the old flat-1600 estimate ($${oldFlatEstimate}) for native 1080p frames`,
  );
});

test("estimateMaxCostUsd: matches Anthropic's documented (width*height)/750 approximation plus the safety margin", () => {
  const model = "claude-opus-5";
  const frameCount = 10;
  const maxTokens = 1000;
  const width = 1280;
  const height = 720;

  const expectedPerImageTokens = Math.ceil(((width * height) / 750) * 1.25); // TOKENS_PER_PIXEL * ESTIMATE_SAFETY_MARGIN
  const expectedInputTokens = frameCount * expectedPerImageTokens + 800; // ESTIMATED_PROMPT_OVERHEAD_TOKENS
  const expected = estimateCostUsd(model, expectedInputTokens, maxTokens);

  const actual = estimateMaxCostUsd(model, frameCount, maxTokens, { width, height });
  assert.equal(actual, expected);
});

test("estimateMaxCostUsd: larger frames produce a strictly larger estimate than smaller ones, all else equal", () => {
  const model = "claude-opus-5";
  const small = estimateMaxCostUsd(model, 20, 4000, { width: 640, height: 360 });
  const large = estimateMaxCostUsd(model, 20, 4000, { width: 3840, height: 2160 }); // 4K dashcam footage
  assert.ok(large > small, `expected 4K frames ($${large}) to estimate higher than 360p frames ($${small})`);
});

test("estimateMaxCostUsd: falls back to a conservative flat estimate when frame dimensions are unavailable", () => {
  const model = "claude-opus-5";
  const withoutDimensions = estimateMaxCostUsd(model, 20, 4000);
  const with720p = estimateMaxCostUsd(model, 20, 4000, { width: 1280, height: 720 });
  // The fallback (3200 tokens/image) is deliberately a safe ceiling for up
  // to ~1080p, so it should be comfortably >= a real 720p estimate too.
  assert.ok(withoutDimensions >= with720p * 0.9, "fallback estimate should not be meaningfully cheaper than a real 720p estimate");
});
