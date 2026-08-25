import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env, requireAnthropicKey } from "@/lib/env";
import { estimateCostUsd, estimateMaxCostUsd } from "@/ai/pricing";
import { recordApiUsage } from "@/ai/costTracking";
import { AiBudgetBlockedError, commitReservation, releaseReservation, reserveAiBudget } from "@/ai/budget";
import type { ReservationKind } from "@/ai/budget";

let cachedClient: Anthropic | undefined;

function client(): Anthropic {
  requireAnthropicKey();
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: env.anthropicApiKey });
  return cachedClient;
}

export interface FrameInput {
  base64: string;
  mediaType: "image/jpeg" | "image/png";
  /** Short label shown right before the image, e.g. "Frame at 00:42 (t=42.1s)". */
  label: string;
}

export interface VisionAnalysisInput<T extends z.ZodTypeAny> {
  schema: T;
  systemPrompt: string;
  /** Final user-turn instructions, appended after all frame/label pairs. */
  instructions: string;
  frames: FrameInput[];
  /** For cost-tracking rows, and the budget reservation kind — "quick_scan" | "detailed_analysis". */
  operation: ReservationKind;
  /** Identifies "this analysis run" for the per-run AI budget cap — see src/ai/budget.ts::generateRunToken. Required: every call must be attributable to a run for the hard per-run cap to mean anything. */
  runToken: string;
  sourceVideoId?: string;
  momentId?: string;
  analysisJobId?: string;
  maxTokens?: number;
}

export interface VisionAnalysisResult<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Sends a batch of frames (each preceded by a text label so Claude knows
 * its timestamp) to Claude vision, forcing the response into `schema` via
 * structured outputs, and records the API cost. Every AI vision call in
 * this app goes through here — which makes this the single enforcement
 * point for the hard AI spending gate (src/ai/budget.ts): budget is
 * reserved atomically immediately before the request is sent, and settled
 * (committed with actual cost, or released) immediately after. Throws
 * `AiBudgetBlockedError` — never silently skips, never silently proceeds —
 * when Paid AI Analysis is off, the key is missing, or the daily/per-run/
 * concurrency limits would be exceeded; callers must catch it explicitly
 * (see analysis.ts) rather than let it fall into generic error handling.
 */
export async function analyzeFrames<T extends z.ZodTypeAny>(
  input: VisionAnalysisInput<T>,
): Promise<VisionAnalysisResult<z.infer<T>>> {
  const maxTokens = input.maxTokens ?? 8000;
  const estimatedCostUsd = estimateMaxCostUsd(env.claudeModel, input.frames.length, maxTokens);

  const reservation = await reserveAiBudget({
    kind: input.operation,
    estimatedCostUsd,
    runToken: input.runToken,
    sourceVideoId: input.sourceVideoId,
    momentId: input.momentId,
  });
  if (!reservation.ok) {
    throw new AiBudgetBlockedError(reservation.reason, reservation.message);
  }

  try {
    const content: Anthropic.Messages.ContentBlockParam[] = [];
    for (const frame of input.frames) {
      content.push({ type: "text", text: frame.label });
      content.push({
        type: "image",
        source: { type: "base64", media_type: frame.mediaType, data: frame.base64 },
      });
    }
    content.push({ type: "text", text: input.instructions });

    const response = await client().messages.parse({
      model: env.claudeModel,
      max_tokens: maxTokens,
      system: input.systemPrompt,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(input.schema) },
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costUsd = estimateCostUsd(env.claudeModel, inputTokens, outputTokens);

    await commitReservation(reservation.reservationId, costUsd);
    await recordApiUsage({
      provider: "anthropic",
      operation: input.operation,
      model: env.claudeModel,
      tokensIn: inputTokens,
      tokensOut: outputTokens,
      estimatedCostUsd,
      costUsd,
      sourceVideoId: input.sourceVideoId,
      momentId: input.momentId,
      analysisJobId: input.analysisJobId,
      runToken: input.runToken,
    });

    if (response.parsed_output === null) {
      throw new Error("Claude vision response did not match the expected schema");
    }

    return { data: response.parsed_output, inputTokens, outputTokens, costUsd };
  } catch (err) {
    await releaseReservation(reservation.reservationId);
    throw err;
  }
}
