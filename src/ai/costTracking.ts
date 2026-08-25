import { prisma } from "@/database/client";

export async function recordApiUsage(input: {
  provider: string;
  operation: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostUsd?: number;
  costUsd: number;
  sourceVideoId?: string;
  momentId?: string;
  discoveryRunId?: string;
  analysisJobId?: string;
  runToken?: string;
}): Promise<void> {
  await prisma.apiUsage.create({
    data: {
      provider: input.provider,
      operation: input.operation,
      model: input.model,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      estimatedCostUsd: input.estimatedCostUsd,
      costUsd: input.costUsd,
      sourceVideoId: input.sourceVideoId,
      momentId: input.momentId,
      discoveryRunId: input.discoveryRunId,
      analysisJobId: input.analysisJobId,
      runToken: input.runToken,
    },
  });
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Confirmed (actual, reconciled) Anthropic spend today — for the dashboard
 * only. Deliberately scoped to `provider: "anthropic"` so it can never be
 * inflated by local ffmpeg/CV processing or other providers' rows (none of
 * which currently carry a nonzero cost, but this keeps the number honestly
 * scoped regardless). This is NOT the budget enforcement point — that's
 * `reserveAiBudget` in src/ai/budget.ts, which also accounts for in-flight
 * reserved spend that this simple confirmed-only sum doesn't include.
 */
export async function todaySpendUsd(): Promise<number> {
  const result = await prisma.apiUsage.aggregate({
    where: { provider: "anthropic", createdAt: { gte: startOfTodayUtc() } },
    _sum: { costUsd: true },
  });
  return result._sum.costUsd ?? 0;
}
