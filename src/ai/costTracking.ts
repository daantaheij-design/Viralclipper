import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";

export async function recordApiUsage(input: {
  provider: string;
  operation: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd: number;
  sourceVideoId?: string;
  momentId?: string;
  discoveryRunId?: string;
}): Promise<void> {
  await prisma.apiUsage.create({
    data: {
      provider: input.provider,
      operation: input.operation,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      costUsd: input.costUsd,
      sourceVideoId: input.sourceVideoId,
      momentId: input.momentId,
      discoveryRunId: input.discoveryRunId,
    },
  });
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function todaySpendUsd(): Promise<number> {
  const result = await prisma.apiUsage.aggregate({
    where: { createdAt: { gte: startOfTodayUtc() } },
    _sum: { costUsd: true },
  });
  return result._sum.costUsd ?? 0;
}

/** Whether today's AI spend is still under the configured daily budget. */
export async function isWithinDailyBudget(): Promise<boolean> {
  const settings = await getSettings();
  if (settings.dailyAiBudgetUsd <= 0) return true; // 0/unset = no cap
  const spent = await todaySpendUsd();
  return spent < settings.dailyAiBudgetUsd;
}
