import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/database/client";
import { updateSettings } from "@/database/settings";
import { env } from "@/lib/env";
import { commitReservation, getBudgetStatus, releaseReservation, reserveAiBudget } from "./budget";

/**
 * Real Postgres throughout — no mocking of the reservation transaction
 * logic (per the cost-control PR's explicit requirement not to mock the
 * critical budget transaction in integration tests). Each test sets
 * exactly the settings it needs and cleans up the rows it creates by a
 * unique runToken, so tests remain order-independent within this file
 * (node:test runs a file's tests sequentially by default).
 */

async function cleanup(runToken: string): Promise<void> {
  await prisma.aiSpendReservation.deleteMany({ where: { runToken } });
  await prisma.apiUsage.deleteMany({ where: { runToken } });
}

test("reserveAiBudget: Paid AI Analysis OFF blocks every call, regardless of available budget", async () => {
  const runToken = randomUUID();
  await updateSettings({ paidAiAnalysisEnabled: false, dailyAiBudgetUsd: 100 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    const result = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.01, runToken });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "paid_ai_disabled");

    const reservationCount = await prisma.aiSpendReservation.count({ where: { runToken } });
    assert.equal(reservationCount, 0, "no reservation row should be created when blocked");
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: missing ANTHROPIC_API_KEY blocks even when Paid AI Analysis is ON", async () => {
  const runToken = randomUUID();
  await updateSettings({ paidAiAnalysisEnabled: true, dailyAiBudgetUsd: 100 });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = undefined;
  try {
    const result = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.01, runToken });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "no_api_key");
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: succeeds when budget is available; commitReservation reconciles actual cost", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 100,
    perRunAiBudgetUsd: 0,
    maxConcurrentAnthropicCalls: 5,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    const result = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.05, runToken });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const reserved = await prisma.aiSpendReservation.findUniqueOrThrow({ where: { id: result.reservationId } });
    assert.equal(reserved.status, "reserved");
    assert.equal(reserved.estimatedCostUsd, 0.05);

    await commitReservation(result.reservationId, 0.031);
    const committed = await prisma.aiSpendReservation.findUniqueOrThrow({ where: { id: result.reservationId } });
    assert.equal(committed.status, "committed");
    assert.equal(committed.actualCostUsd, 0.031);
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("releaseReservation: frees reserved budget immediately (no longer counted as in-flight)", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 100,
    perRunAiBudgetUsd: 0,
    maxConcurrentAnthropicCalls: 5,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    const result = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.07, runToken });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const statusWhileReserved = await getBudgetStatus();
    assert.ok(statusWhileReserved.reservedInFlightUsd >= 0.07);

    await releaseReservation(result.reservationId);
    const released = await prisma.aiSpendReservation.findUniqueOrThrow({ where: { id: result.reservationId } });
    assert.equal(released.status, "released");
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: hard daily budget blocks the request; actual call count never increases (regression case from the spec)", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 0.5,
    perRunAiBudgetUsd: 0,
    maxConcurrentAnthropicCalls: 5,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    // Confirmed spend today: $0.42. Reserved/in-flight: $0.04. Next
    // estimated request: $0.08. Daily limit: $0.50. 0.42+0.04+0.08=0.54 > 0.50.
    await prisma.apiUsage.create({
      data: { provider: "anthropic", operation: "quick_scan", costUsd: 0.42, runToken },
    });
    const otherReservation = await prisma.aiSpendReservation.create({
      data: {
        kind: "quick_scan",
        estimatedCostUsd: 0.04,
        runToken: `${runToken}-other`,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    const result = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.08, runToken });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "daily_budget_exceeded");

    const reservationCount = await prisma.aiSpendReservation.count({ where: { runToken } });
    assert.equal(reservationCount, 0, "blocked request must not create a reservation (no call happens)");

    await prisma.aiSpendReservation.delete({ where: { id: otherReservation.id } });
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: per-run budget blocks even when the daily budget still has room", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 100, // plenty of daily room
    perRunAiBudgetUsd: 0.2,
    maxConcurrentAnthropicCalls: 5,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    await prisma.apiUsage.create({
      data: { provider: "anthropic", operation: "quick_scan", costUsd: 0.15, runToken },
    });

    const result = await reserveAiBudget({ kind: "detailed_analysis", estimatedCostUsd: 0.1, runToken });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "per_run_budget_exceeded");
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: concurrency limit blocks a second in-flight call", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 100,
    perRunAiBudgetUsd: 0,
    maxConcurrentAnthropicCalls: 1,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    const first = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.01, runToken });
    assert.equal(first.ok, true);

    const second = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.01, runToken: `${runToken}-2` });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "concurrency_limit_reached");

    await cleanup(`${runToken}-2`);
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: atomic reservation prevents concurrent overspend past the daily budget (real Postgres, real concurrency)", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 0.1,
    perRunAiBudgetUsd: 0,
    maxConcurrentAnthropicCalls: 100, // isolate this test to the DAILY budget check, not concurrency
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    // 5 genuinely concurrent reservation attempts, each $0.06 — only one
    // can fit under a $0.10 daily budget (two would already be $0.12).
    // Without the pg_advisory_xact_lock serializing these, a naive
    // read-then-write race could let more than one through.
    const attempts = Array.from({ length: 5 }, (_, i) =>
      reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.06, runToken: `${runToken}-${i}` }),
    );
    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.ok);
    assert.equal(succeeded.length, 1, `expected exactly 1 of 5 concurrent $0.06 reservations to fit a $0.10 budget, got ${succeeded.length}`);

    for (let i = 0; i < 5; i++) await cleanup(`${runToken}-${i}`);
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});

test("reserveAiBudget: an expired (abandoned) reservation stops counting toward in-flight spend", async () => {
  const runToken = randomUUID();
  await updateSettings({
    paidAiAnalysisEnabled: true,
    dailyAiBudgetUsd: 0.1,
    perRunAiBudgetUsd: 0,
    maxConcurrentAnthropicCalls: 100,
  });
  const before = env.anthropicApiKey;
  env.anthropicApiKey = "sk-test-fake-key";
  try {
    // An "abandoned" reservation (e.g. a crashed process) that never got
    // committed or released, well past its TTL.
    await prisma.aiSpendReservation.create({
      data: {
        kind: "quick_scan",
        estimatedCostUsd: 0.09,
        runToken: `${runToken}-stale`,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    // If the stale reservation still counted, 0.09 + 0.05 > 0.10 would block.
    const result = await reserveAiBudget({ kind: "quick_scan", estimatedCostUsd: 0.05, runToken });
    assert.equal(result.ok, true, "expired reservation should have been auto-released and excluded");

    const stale = await prisma.aiSpendReservation.findFirst({ where: { runToken: `${runToken}-stale` } });
    assert.equal(stale?.status, "released");

    await cleanup(`${runToken}-stale`);
  } finally {
    env.anthropicApiKey = before;
    await cleanup(runToken);
  }
});
