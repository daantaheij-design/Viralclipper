import { prisma } from "./client";
import { allSourceNames } from "@/sources/registry";

// Only YouTube is enabled out of the box — a conservative default for the
// first live run. Enable Reddit from the Sources page once YouTube-only has
// been verified end to end.
const DEFAULT_ENABLED_SOURCES = new Set(["youtube"]);

/** Idempotently makes sure every registered source has a config row. */
export async function seedSources(): Promise<void> {
  for (const name of allSourceNames()) {
    await prisma.source.upsert({
      where: { name },
      create: { name, enabled: DEFAULT_ENABLED_SOURCES.has(name) },
      update: {},
    });
  }
}

async function main() {
  await seedSources();
  console.log("Seeded sources:", allSourceNames().join(", "));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
