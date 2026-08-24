import { prisma } from "@/database/client";
import { seedSources } from "@/database/seed";
import { runFullPipeline } from "@/jobs/pipeline";

async function main() {
  await seedSources();
  const result = await runFullPipeline({ forceDiscovery: true });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
