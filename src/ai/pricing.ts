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
