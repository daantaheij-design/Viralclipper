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

// Deliberately pessimistic (rounds up) per-image token estimate used only to
// reserve budget *before* a call is made, when real usage isn't known yet —
// Claude's actual image tokenization varies with resolution, but this is a
// safe ceiling for the frame sizes this app extracts (see video/ffmpeg.ts).
// A reservation that slightly overestimates just blocks a hair earlier than
// strictly necessary; one that underestimates would let spend slip past the
// hard cap, which is the one failure mode that isn't acceptable here.
const ESTIMATED_TOKENS_PER_IMAGE = 1600;
const ESTIMATED_PROMPT_OVERHEAD_TOKENS = 800;

/**
 * Pessimistic upper-bound cost estimate for one `analyzeFrames` call, used
 * to reserve budget before the request is sent (see src/ai/budget.ts). Uses
 * `maxTokens` (the request's own output cap) as the output-token estimate,
 * since actual output can never exceed what was requested.
 */
export function estimateMaxCostUsd(model: string, frameCount: number, maxTokens: number): number {
  const estimatedInputTokens = frameCount * ESTIMATED_TOKENS_PER_IMAGE + ESTIMATED_PROMPT_OVERHEAD_TOKENS;
  return estimateCostUsd(model, estimatedInputTokens, maxTokens);
}
