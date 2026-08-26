import { randomUUID } from "node:crypto";
import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { env } from "@/lib/env";

/**
 * Atomic AI-spend budget gate — the single place that decides whether the
 * next Anthropic request is allowed to happen, and the only place that may
 * create/settle an `AiSpendReservation` row. Called from exactly one place
 * in production code: `analyzeFrames` (src/ai/providers/claude.ts), which
 * is itself the only place this app ever calls the Anthropic API — so this
 * module is the hard backstop req'd by the cost-control PR: worker ticks,
 * manual discovery runs, retries, "Analyze Again", and concurrent
 * processes all funnel through the same reservation check, and none of
 * them can bypass it.
 *
 * Why a Postgres advisory lock rather than an in-memory counter: the web
 * service and the worker are separate processes (and the worker could in
 * principle run more than one replica), so only a database-enforced lock
 * actually serializes concurrent reservation attempts. `pg_advisory_xact_lock`
 * is scoped to the current transaction — it's acquired at the start of the
 * `$transaction` below and released automatically when that transaction
 * commits or rolls back, so a crashed process can never leave it held.
 */

/** Thrown by `analyzeFrames` when `reserveAiBudget` blocks the call — mirrors `AcquisitionError`'s pattern (src/video/acquisitionErrors.ts) so callers can `instanceof`-branch on it instead of treating it like a generic API failure. */
export class AiBudgetBlockedError extends Error {
  constructor(
    public readonly reason: BudgetBlockReason,
    message: string,
  ) {
    super(message);
    this.name = "AiBudgetBlockedError";
  }
}

export type ReservationKind = "quick_scan" | "detailed_analysis";

export interface ReserveBudgetInput {
  kind: ReservationKind;
  estimatedCostUsd: number;
  runToken: string;
  sourceVideoId?: string;
  momentId?: string;
}

export type BudgetBlockReason =
  | "paid_ai_disabled"
  | "no_api_key"
  | "daily_budget_exceeded"
  | "per_run_budget_exceeded"
  | "concurrency_limit_reached";

export interface BudgetSnapshot {
  confirmedTodayUsd: number;
  reservedInFlightUsd: number;
  runConfirmedUsd: number;
  runReservedUsd: number;
}

export type ReserveBudgetResult =
  | { ok: true; reservationId: string; before: BudgetSnapshot }
  | { ok: false; reason: BudgetBlockReason; message: string };

// Arbitrary fixed key identifying "the AI budget lock" among any other
// advisory locks this app might ever take — must stay constant.
const ADVISORY_LOCK_KEY = 833221654;

// A reservation guards exactly one Anthropic request, which normally
// resolves in well under a minute. 10 minutes is generous headroom before
// an abandoned reservation (crashed process) is treated as released and
// stops counting toward in-flight spend/concurrency.
const RESERVATION_TTL_MS = 10 * 60 * 1000;

function startOfTodayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** One token identifying "this analysis run" for the per-run budget cap — generate once per `runAnalysis()` invocation. */
export function generateRunToken(): string {
  return randomUUID();
}

export async function reserveAiBudget(input: ReserveBudgetInput): Promise<ReserveBudgetResult> {
  const settings = await getSettings();

  // Cheap checks that don't need the lock/transaction at all — fail fast.
  if (!settings.paidAiAnalysisEnabled) {
    return {
      ok: false,
      reason: "paid_ai_disabled",
      message: "Paid AI Analysis is OFF in Settings — no Anthropic calls are permitted.",
    };
  }
  if (!env.anthropicApiKey) {
    return { ok: false, reason: "no_api_key", message: "ANTHROPIC_API_KEY is not set." };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;

    const now = new Date();

    // Abandoned reservations stop counting toward in-flight spend/concurrency.
    await tx.aiSpendReservation.updateMany({
      where: { status: "reserved", expiresAt: { lt: now } },
      data: { status: "released" },
    });

    const [confirmedTodayAgg, reservedAgg, reservedCount, runConfirmedAgg, runReservedAgg] = await Promise.all([
      tx.apiUsage.aggregate({
        where: { provider: "anthropic", createdAt: { gte: startOfTodayUtc(now) } },
        _sum: { costUsd: true },
      }),
      tx.aiSpendReservation.aggregate({ where: { status: "reserved" }, _sum: { estimatedCostUsd: true } }),
      tx.aiSpendReservation.count({ where: { status: "reserved" } }),
      tx.apiUsage.aggregate({
        where: { provider: "anthropic", runToken: input.runToken },
        _sum: { costUsd: true },
      }),
      tx.aiSpendReservation.aggregate({
        where: { status: "reserved", runToken: input.runToken },
        _sum: { estimatedCostUsd: true },
      }),
    ]);

    const confirmedToday = confirmedTodayAgg._sum.costUsd ?? 0;
    const reservedInFlight = reservedAgg._sum.estimatedCostUsd ?? 0;
    const runConfirmed = runConfirmedAgg._sum.costUsd ?? 0;
    const runReserved = runReservedAgg._sum.estimatedCostUsd ?? 0;

    if (reservedCount >= settings.maxConcurrentAnthropicCalls) {
      return {
        ok: false,
        reason: "concurrency_limit_reached",
        message: `${reservedCount} Anthropic call(s) already in flight (limit ${settings.maxConcurrentAnthropicCalls}).`,
      };
    }

    const projectedDaily = confirmedToday + reservedInFlight + input.estimatedCostUsd;
    if (settings.dailyAiBudgetUsd > 0 && projectedDaily > settings.dailyAiBudgetUsd) {
      return {
        ok: false,
        reason: "daily_budget_exceeded",
        message: `Daily AI budget would be exceeded: confirmed $${confirmedToday.toFixed(4)} + reserved $${reservedInFlight.toFixed(4)} + next $${input.estimatedCostUsd.toFixed(4)} > limit $${settings.dailyAiBudgetUsd.toFixed(2)}.`,
      };
    }

    const projectedRun = runConfirmed + runReserved + input.estimatedCostUsd;
    if (settings.perRunAiBudgetUsd > 0 && projectedRun > settings.perRunAiBudgetUsd) {
      return {
        ok: false,
        reason: "per_run_budget_exceeded",
        message: `Per-run AI budget would be exceeded: $${projectedRun.toFixed(4)} > limit $${settings.perRunAiBudgetUsd.toFixed(2)}.`,
      };
    }

    const reservation = await tx.aiSpendReservation.create({
      data: {
        kind: input.kind,
        estimatedCostUsd: input.estimatedCostUsd,
        runToken: input.runToken,
        sourceVideoId: input.sourceVideoId,
        momentId: input.momentId,
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
      },
    });

    return {
      ok: true,
      reservationId: reservation.id,
      before: {
        confirmedTodayUsd: confirmedToday,
        reservedInFlightUsd: reservedInFlight,
        runConfirmedUsd: runConfirmed,
        runReservedUsd: runReserved,
      },
    };
  });
}

/** Call after a successful Anthropic request — converts the reservation into confirmed (reconciled) actual cost. */
export async function commitReservation(reservationId: string, actualCostUsd: number): Promise<void> {
  await prisma.aiSpendReservation.update({
    where: { id: reservationId },
    data: { status: "committed", actualCostUsd },
  });
}

/** Call when the reserved request never happened (or failed before any usage was incurred) — frees the reserved budget immediately. */
export async function releaseReservation(reservationId: string): Promise<void> {
  await prisma.aiSpendReservation.update({ where: { id: reservationId }, data: { status: "released" } });
}

export interface BudgetStatus {
  confirmedTodayUsd: number;
  reservedInFlightUsd: number;
  dailyBudgetUsd: number;
  remainingUsd: number;
  callsToday: number;
  concurrentCallsInFlight: number;
}

/** Read-only snapshot for the Settings/cost dashboard — not used for enforcement (that's reserveAiBudget alone). */
export async function getBudgetStatus(): Promise<BudgetStatus> {
  const settings = await getSettings();
  const now = new Date();
  await prisma.aiSpendReservation.updateMany({
    where: { status: "reserved", expiresAt: { lt: now } },
    data: { status: "released" },
  });

  const [confirmedAgg, reservedAgg, callsToday, concurrentCallsInFlight] = await Promise.all([
    prisma.apiUsage.aggregate({
      where: { provider: "anthropic", createdAt: { gte: startOfTodayUtc(now) } },
      _sum: { costUsd: true },
    }),
    prisma.aiSpendReservation.aggregate({ where: { status: "reserved" }, _sum: { estimatedCostUsd: true } }),
    prisma.apiUsage.count({ where: { provider: "anthropic", createdAt: { gte: startOfTodayUtc(now) } } }),
    prisma.aiSpendReservation.count({ where: { status: "reserved" } }),
  ]);

  const confirmedTodayUsd = confirmedAgg._sum.costUsd ?? 0;
  const reservedInFlightUsd = reservedAgg._sum.estimatedCostUsd ?? 0;

  return {
    confirmedTodayUsd,
    reservedInFlightUsd,
    dailyBudgetUsd: settings.dailyAiBudgetUsd,
    remainingUsd: Math.max(settings.dailyAiBudgetUsd - confirmedTodayUsd - reservedInFlightUsd, 0),
    callsToday,
    concurrentCallsInFlight,
  };
}
