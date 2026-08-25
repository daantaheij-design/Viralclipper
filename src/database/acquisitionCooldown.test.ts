import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNextRetryAt } from "./acquisitionCooldown";

const now = new Date("2026-01-01T00:00:00Z");

test("computeNextRetryAt: first failure waits the base cooldown (30min)", () => {
  const retryAt = computeNextRetryAt(1, now);
  assert.equal(retryAt.getTime() - now.getTime(), 30 * 60_000);
});

test("computeNextRetryAt: backs off exponentially with repeated failures", () => {
  assert.equal(computeNextRetryAt(2, now).getTime() - now.getTime(), 60 * 60_000);
  assert.equal(computeNextRetryAt(3, now).getTime() - now.getTime(), 120 * 60_000);
  assert.equal(computeNextRetryAt(4, now).getTime() - now.getTime(), 240 * 60_000);
});

test("computeNextRetryAt: caps out at 24 hours instead of growing forever", () => {
  const retryAt = computeNextRetryAt(20, now);
  assert.equal(retryAt.getTime() - now.getTime(), 24 * 60 * 60_000);
});
