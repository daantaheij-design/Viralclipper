import { randomUUID } from "node:crypto";
import { prisma } from "./client";

/**
 * A simple named mutex backed by an atomic `UPDATE ... WHERE ... RETURNING`
 * compare-and-swap — a single SQL statement is atomic in Postgres, so this
 * needs no explicit transaction or advisory lock. Used to make sure a
 * discovery run or an analysis batch never runs twice concurrently across
 * the web service and the worker (or multiple worker replicas); see
 * jobs/discovery.ts and jobs/analysis.ts.
 *
 * A lock held past `staleAfterMs` (its holder crashed without releasing
 * it) is treated as free and can be reclaimed by the next caller — so a
 * crash can never wedge the lock permanently.
 */

export interface AcquiredLock {
  acquired: boolean;
  /** Present only when acquired=true — pass to releaseLock. */
  token?: string;
}

export async function tryAcquireLock(name: string, staleAfterMs: number): Promise<AcquiredLock> {
  const token = randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleAfterMs);

  // Bootstrap the row on first-ever use. ON CONFLICT DO NOTHING so this
  // never clobbers a lock another process is currently holding.
  await prisma.$executeRaw`
    INSERT INTO "job_locks" ("name", "status", "updatedAt")
    VALUES (${name}, 'idle', ${now})
    ON CONFLICT ("name") DO NOTHING
  `;

  const rows = await prisma.$queryRaw<{ name: string }[]>`
    UPDATE "job_locks"
    SET "status" = 'running', "holderToken" = ${token}, "startedAt" = ${now}, "updatedAt" = ${now}
    WHERE "name" = ${name}
      AND ("status" = 'idle' OR ("startedAt" IS NOT NULL AND "startedAt" < ${staleBefore}))
    RETURNING "name"
  `;

  return rows.length > 0 ? { acquired: true, token } : { acquired: false };
}

export async function releaseLock(name: string, token: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "job_locks"
    SET "status" = 'idle', "holderToken" = NULL, "updatedAt" = ${new Date()}
    WHERE "name" = ${name} AND "holderToken" = ${token}
  `;
}

export async function isLockHeld(name: string, staleAfterMs: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleAfterMs);
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "job_locks"
    WHERE "name" = ${name} AND "status" = 'running' AND "startedAt" IS NOT NULL AND "startedAt" >= ${staleBefore}
  `;
  return rows.length > 0;
}
