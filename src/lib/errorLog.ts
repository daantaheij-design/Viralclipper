import { prisma } from "@/database/client";
import type { Prisma } from "@/generated/prisma";

export async function logError(
  scope: string,
  message: string,
  err?: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const detail = err instanceof Error ? err.message : err ? String(err) : undefined;
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(`[${scope}] ${message}`, detail ?? "");

  try {
    await prisma.errorLog.create({
      data: {
        scope,
        message: detail ? `${message}: ${detail}` : message,
        stack,
        context: context as Prisma.InputJsonValue,
      },
    });
  } catch {
    // Logging must never throw and take down the caller.
  }
}
