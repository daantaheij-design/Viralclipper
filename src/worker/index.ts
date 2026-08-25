import cron from "node-cron";
import { prisma } from "@/database/client";
import { seedSources } from "@/database/seed";
import { getSettings } from "@/database/settings";
import { logError } from "@/lib/errorLog";
import { runStartupSelfTest } from "@/lib/selfTest";
import { runDiscoveryJob } from "@/jobs/discovery";
import { runAnalysis } from "@/jobs/analysis";
import { runProcessing } from "@/jobs/processing";

const TICK_CRON = "*/5 * * * *"; // every 5 minutes

let running = false;

async function shouldRunDiscoveryNow(frequencyHours: number): Promise<boolean> {
  const lastRun = await prisma.discoveryRun.findFirst({ orderBy: { startedAt: "desc" } });
  if (!lastRun) return true;
  const elapsedHours = (Date.now() - lastRun.startedAt.getTime()) / (1000 * 60 * 60);
  return elapsedHours >= frequencyHours;
}

async function tick(): Promise<void> {
  if (running) {
    console.log("[worker] previous tick still running, skipping");
    return;
  }
  running = true;
  try {
    const settings = await getSettings();

    if (settings.automaticDiscoveryEnabled && (await shouldRunDiscoveryNow(settings.discoveryFrequencyHours))) {
      console.log("[worker] running discovery");
      const result = await runDiscoveryJob();
      console.log("[worker] discovery", result.outcome, result.outcome === "completed" ? result.summary : "");
    }

    console.log("[worker] running analysis");
    const analysisSummary = await runAnalysis();
    console.log("[worker] analysis done", analysisSummary);

    console.log("[worker] running processing (9:16 render)");
    const processingSummary = await runProcessing();
    console.log("[worker] processing done", processingSummary);
  } catch (err) {
    await logError("worker", "Tick failed", err);
  } finally {
    running = false;
  }
}

async function main() {
  await runStartupSelfTest();
  await seedSources();
  console.log(`[worker] starting — tick schedule "${TICK_CRON}"`);

  // Run once immediately on boot instead of waiting for the first cron tick.
  void tick();

  cron.schedule(TICK_CRON, () => {
    void tick();
  });
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
