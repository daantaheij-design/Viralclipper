import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env, requireAnthropicKey } from "@/lib/env";
import { estimateCostUsd } from "@/ai/pricing";
import { recordApiUsage } from "@/ai/costTracking";

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
  /** For cost-tracking rows, e.g. "quick_scan" | "detailed_analysis". */
  operation: string;
  sourceVideoId?: string;
  momentId?: string;
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
 * this app goes through here so cost tracking can't drift.
 */
export async function analyzeFrames<T extends z.ZodTypeAny>(
  input: VisionAnalysisInput<T>,
): Promise<VisionAnalysisResult<z.infer<T>>> {
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
    max_tokens: input.maxTokens ?? 8000,
    system: input.systemPrompt,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(input.schema) },
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd = estimateCostUsd(env.claudeModel, inputTokens, outputTokens);

  await recordApiUsage({
    provider: "anthropic",
    operation: input.operation,
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    costUsd,
    sourceVideoId: input.sourceVideoId,
    momentId: input.momentId,
  });

  if (response.parsed_output === null) {
    throw new Error("Claude vision response did not match the expected schema");
  }

  return { data: response.parsed_output, inputTokens, outputTokens, costUsd };
}
