import type { Category, SourceName } from "@/generated/prisma";
import { prisma } from "@/database/client";
import { LONG_TAIL_MODIFIERS, SEED_QUERIES } from "./seedQueries";

/** Makes sure every seed query exists as a row for the given source/category. */
async function ensureSeedQueries(sourceId: string, category: Category): Promise<void> {
  const seeds = SEED_QUERIES[category] ?? [];
  if (seeds.length === 0) return;

  await prisma.searchQuery.createMany({
    data: seeds.map((text) => ({
      sourceId,
      category,
      text,
      generatedBy: "seed",
    })),
    skipDuplicates: true,
  });
}

/** Generates a handful of long-tail variants by combining a seed with a modifier. */
async function generateLongTail(sourceId: string, category: Category): Promise<void> {
  const seeds = SEED_QUERIES[category] ?? [];
  if (seeds.length === 0) return;

  const existingCount = await prisma.searchQuery.count({
    where: { sourceId, category, generatedBy: "long_tail" },
  });
  // Cap long-tail growth so the query table doesn't grow unbounded run over run.
  if (existingCount >= seeds.length * 3) return;

  const base = seeds[Math.floor(Math.random() * seeds.length)];
  const modifier = LONG_TAIL_MODIFIERS[Math.floor(Math.random() * LONG_TAIL_MODIFIERS.length)];
  const text = `${base} ${modifier}`;

  await prisma.searchQuery.upsert({
    where: { sourceId_category_text: { sourceId, category, text } },
    create: { sourceId, category, text, generatedBy: "long_tail" },
    update: {},
  });
}

/**
 * Picks the next `count` queries to run for a source across the given
 * categories, favoring queries that haven't been used recently (or ever) so
 * repeated discovery runs rotate through the whole set instead of hammering
 * the same handful of terms.
 */
export async function pickQueriesForRun(
  sourceId: string,
  sourceName: SourceName,
  categories: Category[],
  count: number,
): Promise<{ id: string; text: string; category: Category }[]> {
  for (const category of categories) {
    await ensureSeedQueries(sourceId, category);
    // Occasionally mint a new long-tail query so the pool keeps growing.
    if (Math.random() < 0.3) await generateLongTail(sourceId, category);
  }

  const queries = await prisma.searchQuery.findMany({
    where: { sourceId, category: { in: categories }, active: true },
    orderBy: [{ lastUsedAt: { sort: "asc", nulls: "first" } }, { timesUsed: "asc" }],
    take: count,
  });

  return queries.map((q) => ({ id: q.id, text: q.text, category: q.category }));
}

export async function markQueryUsed(queryId: string): Promise<void> {
  await prisma.searchQuery.update({
    where: { id: queryId },
    data: { lastUsedAt: new Date(), timesUsed: { increment: 1 } },
  });
}
