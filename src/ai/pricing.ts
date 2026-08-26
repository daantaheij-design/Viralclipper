// Approximate first-party Anthropic API pricing, USD per million tokens.
// Used only for the cost dashboard — not billing-accurate, just enough to
// give a sense of spend. Update alongside CLAUDE_MODEL if you change models.
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const DEFAULT_PRICING = { input: 5, output: 25 }; // Opus-tier fallback

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING_PER_MTOK[model] ?? DEFAULT_PRICING;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/**
 * Deliberately pessimistic (rounds up) per-image token estimate used only
 * to reserve budget *before* a call is made, when real usage isn't known
 * yet. Anthropic's documented image-tokenization approximation is
 * `tokens ≈ (width_px * height_px) / 750`. This matters here specifically
 * because `video/ffmpeg.ts::extractFrames` never resizes frames before
 * they're sent to Claude — they go out at the source video's native
 * resolution, commonly 1080p or higher for real YouTube/dashcam footage.
 *
 * A previous flat "1600 tokens/image" estimate implicitly assumed a much
 * smaller image than that (roughly ~1100x1100) and was a confirmed,
 * concrete contributor to actual spend exceeding the configured daily
 * budget in production: each reservation looked "within budget" against an
 * estimate that undershot the real cost of a full-resolution 1080p+ frame,
 * so the *sum* of several individually-approved, individually-honest-looking
 * reservations could still land the day's *actual* total above the cap.
 * The hard budget gate (src/ai/budget.ts) is only as hard as this estimate
 * is honest — don't shrink it back down without re-verifying against real
 * frame sizes and real Anthropic usage.
 */
const TOKENS_PER_PIXEL = 1 / 750;
const ESTIMATE_SAFETY_MARGIN = 1.25; // headroom over the raw formula — tokenization isn't guaranteed to match the approximation exactly
const FALLBACK_TOKENS_PER_IMAGE = 3200; // used only when frame dimensions are unavailable — a safe ceiling for up to ~1080p (1920x1080 alone is ~2765 before margin)
const ESTIMATED_PROMPT_OVERHEAD_TOKENS = 800;

export interface FrameDimensions {
  width: number;
  height: number;
}

function estimatedTokensPerImage(dimensions?: FrameDimensions): number {
  if (!dimensions || !dimensions.width || !dimensions.height) return FALLBACK_TOKENS_PER_IMAGE;
  return Math.ceil(dimensions.width * dimensions.height * TOKENS_PER_PIXEL * ESTIMATE_SAFETY_MARGIN);
}

/**
 * Pessimistic upper-bound cost estimate for one `analyzeFrames` call, used
 * to reserve budget before the request is sent (see src/ai/budget.ts). Uses
 * `maxTokens` (the request's own output cap) as the output-token estimate,
 * since actual output can never exceed what was requested. Pass the source
 * video's actual frame dimensions when known (quickScan.ts/detailedAnalysis.ts
 * both have `VideoInfo` already) — falls back to a conservative flat
 * per-image estimate otherwise.
 */
export function estimateMaxCostUsd(
  model: string,
  frameCount: number,
  maxTokens: number,
  frameDimensions?: FrameDimensions,
): number {
  const perImage = estimatedTokensPerImage(frameDimensions);
  const estimatedInputTokens = frameCount * perImage + ESTIMATED_PROMPT_OVERHEAD_TOKENS;
  return estimateCostUsd(model, estimatedInputTokens, maxTokens);
}
