import { logError } from "@/lib/errorLog";
import { runDiscoveryJob } from "./discovery";
import { runAnalysis } from "./analysis";
import { runProcessing } from "./processing";

export interface PipelineRunResult {
  discovery: Awaited<ReturnType<typeof runDiscoveryJob>>;
  analysis: Awaited<ReturnType<typeof runAnalysis>> | null;
  processing: Awaited<ReturnType<typeof runProcessing>> | null;
}

/**
 * Runs the whole DISCOVER → FILTER → ANALYZE → SCORE → 9:16 pipeline once,
 * end to end. Each stage is wrapped individually so a failure partway
 * through doesn't lose the stages that already succeeded.
 */
export async function runFullPipeline(opts: { forceDiscovery?: boolean } = {}): Promise<PipelineRunResult> {
  const result: PipelineRunResult = { discovery: null, analysis: null, processing: null };

  try {
    result.discovery = await runDiscoveryJob({ force: opts.forceDiscovery });
  } catch (err) {
    await logError("pipeline", "Discovery stage failed", err);
  }

  try {
    result.analysis = await runAnalysis();
  } catch (err) {
    await logError("pipeline", "Analysis stage failed", err);
  }

  try {
    result.processing = await runProcessing();
  } catch (err) {
    await logError("pipeline", "Processing stage failed", err);
  }

  return result;
}
