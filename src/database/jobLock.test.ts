import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./client";
import { isLockHeld, releaseLock, tryAcquireLock } from "./jobLock";

function lockName(): string {
  return `test-lock-${Math.random().toString(36).slice(2)}`;
}

async function cleanup(name: string): Promise<void> {
  await prisma.jobLock.deleteMany({ where: { name } });
}

test("tryAcquireLock: a fresh lock is acquired immediately", async () => {
  const name = lockName();
  try {
    const lock = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(lock.acquired, true);
    assert.ok(lock.token);
  } finally {
    await cleanup(name);
  }
});

test("tryAcquireLock: a second attempt on a held lock is refused", async () => {
  const name = lockName();
  try {
    const first = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(first.acquired, true);

    const second = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(second.acquired, false);
  } finally {
    await cleanup(name);
  }
});

test("releaseLock: frees the lock for the next caller", async () => {
  const name = lockName();
  try {
    const first = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(first.acquired, true);
    await releaseLock(name, first.token!);

    const second = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(second.acquired, true);
  } finally {
    await cleanup(name);
  }
});

test("tryAcquireLock: a stale lock (holder crashed) can be reclaimed after staleAfterMs", async () => {
  const name = lockName();
  try {
    const first = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(first.acquired, true);
    // Simulate a crashed holder: backdate startedAt well past a short staleAfterMs.
    await prisma.jobLock.update({ where: { name }, data: { startedAt: new Date(Date.now() - 10_000) } });

    const reclaimed = await tryAcquireLock(name, 1000); // 1s staleness window
    assert.equal(reclaimed.acquired, true);
    assert.notEqual(reclaimed.token, first.token);
  } finally {
    await cleanup(name);
  }
});

test("isLockHeld: true while running, false once released", async () => {
  const name = lockName();
  try {
    assert.equal(await isLockHeld(name, 30 * 60_000), false);
    const lock = await tryAcquireLock(name, 30 * 60_000);
    assert.equal(await isLockHeld(name, 30 * 60_000), true);
    await releaseLock(name, lock.token!);
    assert.equal(await isLockHeld(name, 30 * 60_000), false);
  } finally {
    await cleanup(name);
  }
});

test("tryAcquireLock: real concurrency — exactly one of many simultaneous attempts wins", async () => {
  const name = lockName();
  try {
    const attempts = Array.from({ length: 8 }, () => tryAcquireLock(name, 30 * 60_000));
    const results = await Promise.all(attempts);
    const acquired = results.filter((r) => r.acquired);
    assert.equal(acquired.length, 1, `expected exactly 1 of 8 concurrent lock attempts to win, got ${acquired.length}`);
  } finally {
    await cleanup(name);
  }
});
