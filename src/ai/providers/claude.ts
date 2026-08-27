import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env, requireAnthropicKey } from "@/lib/env";
import { estimateCostUsd, estimateInputTokens } from "@/ai/pricing";
import type { FrameDimensions } from "@/ai/pricing";
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
  /** The actual dimensions of the frames being sent (after any local resize — see video/ffmpeg.ts's `maxWidth`/`maxHeight`) — used to make the pre-call cost estimate realistic instead of a flat guess. See src/ai/pricing.ts. */
  frameDimensions?: FrameDimensions;
  /** 1-based position of this request among `plannedRequestCount` for the same candidate/stage — purely for observability (see the `[anthropic]` logs below). Omit for a stage that's always exactly one request (e.g. quick scan); both default to 1 when omitted. */
  requestIndex?: number;
  plannedRequestCount?: number;
  /** Source-video-absolute seconds this request's frames span — omit for a request (like quick scan) that samples the whole video rather than one candidate window. */
  candidateWindowStart?: number;
  candidateWindowEnd?: number;
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
 *
 * Logs a `[anthropic] request starting`/`request completed` pair for every
 * real attempt — the production incident that added this (a dashboard
 * showing 2 new Anthropic calls while a worker tick's own summary claimed
 * 0) was ultimately a log-attribution problem, not a data-correctness one:
 * these lines, tagged with sourceVideoId/stage and printed from the one
 * choke point every call goes through, are what let you grep any service's
 * log for "did *this* process make an Anthropic call" without relying on
 * a possibly-stale in-memory summary computed elsewhere.
 */
export async function analyzeFrames<T extends z.ZodTypeAny>(
  input: VisionAnalysisInput<T>,
): Promise<VisionAnalysisResult<z.infer<T>>> {
  const maxTokens = input.maxTokens ?? 8000;
  const estimatedInputTokens = estimateInputTokens(input.frames.length, input.frameDimensions);
  const estimatedCostUsd = estimateCostUsd(env.claudeModel, estimatedInputTokens, maxTokens);

  const requestIndex = input.requestIndex ?? 1;
  const plannedRequestCount = input.plannedRequestCount ?? 1;
  // A stage that's genuinely always one request logs as plain "quick_scan"/
  // "detailed_analysis"; a stage that legitimately needed more than one
  // request logs as "quick_batch_1_of_2" etc. so two requests for the same
  // candidate/stage are never indistinguishable in the logs — the exact
  // production incident this exists to prevent recurring silently.
  const stageLabel = plannedRequestCount > 1 ? `${input.operation}_batch_${requestIndex}_of_${plannedRequestCount}` : input.operation;

  const logFields = {
    sourceVideoId: input.sourceVideoId,
    stage: stageLabel,
    requestIndex,
    plannedRequestCount,
    frameCount: input.frames.length,
    frameWidth: input.frameDimensions?.width,
    frameHeight: input.frameDimensions?.height,
    candidateWindowStart: input.candidateWindowStart,
    candidateWindowEnd: input.candidateWindowEnd,
  };

  const reservation = await reserveAiBudget({
    kind: input.operation,
    estimatedCostUsd,
    runToken: input.runToken,
    sourceVideoId: input.sourceVideoId,
    momentId: input.momentId,
  });
  if (!reservation.ok) {
    console.log("[anthropic] request blocked", {
      ...logFields,
      reservationUsd: Number(estimatedCostUsd.toFixed(4)),
      reason: reservation.reason,
    });
    throw new AiBudgetBlockedError(reservation.reason, reservation.message);
  }

  console.log("[anthropic] request starting", {
    ...logFields,
    reservationUsd: Number(estimatedCostUsd.toFixed(4)),
    estimatedInputTokens,
    dailySpentBefore: Number(reservation.before.confirmedTodayUsd.toFixed(4)),
    dailyReservedBefore: Number(reservation.before.reservedInFlightUsd.toFixed(4)),
    runSpentBefore: Number(reservation.before.runConfirmedUsd.toFixed(4)),
  });

  let committed = false;
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
    committed = true;
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
      console.log("[anthropic] request completed", {
        ...logFields,
        estimatedInputTokens,
        actualInputTokens: inputTokens,
        actualOutputTokens: outputTokens,
        actualCostUsd: Number(costUsd.toFixed(4)),
        result: "schema_mismatch",
      });
      throw new Error("Claude vision response did not match the expected schema");
    }

    console.log("[anthropic] request completed", {
      ...logFields,
      estimatedInputTokens,
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      actualCostUsd: Number(costUsd.toFixed(4)),
      result: "ok",
    });

    return { data: response.parsed_output, inputTokens, outputTokens, costUsd };
  } catch (err) {
    // Only release if the reservation was never committed to an actual
    // cost — committing already recorded the real spend (the API call
    // genuinely happened and must count), so releasing afterward would
    // leave the reservation's own status misleadingly showing "released"
    // for a request that actually completed and was billed.
    if (!committed) await releaseReservation(reservation.reservationId);
    throw err;
  }
}
