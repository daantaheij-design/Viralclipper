import { prisma } from "./client";
import { allSourceNames } from "@/sources/registry";

/** Idempotently makes sure every registered source has a config row. */
export async function seedSources(): Promise<void> {
  for (const name of allSourceNames()) {
    await prisma.source.upsert({
      where: { name },
      create: { name, enabled: true },
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
