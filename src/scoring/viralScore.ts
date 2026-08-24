import type { Scores } from "@/analysis/schemas";

const SCORE_KEYS = [
  "hook",
  "visual_action",
  "conflict",
  "escalation",
  "surprise",
  "emotion",
  "payoff",
  "understandability",
  "retention",
  "rewatch",
  "tiktok_suitability",
] as const satisfies readonly (keyof Scores)[];

/**
 * The single 0-100 viral score is the mean of the 11 sub-scores — computed
 * here (not trusted from the model's own opinion) so it's auditable and
 * consistent across moments even if prompt wording drifts.
 */
export function computeViralScore(scores: Scores): number {
  const sum = SCORE_KEYS.reduce((total, key) => total + scores[key], 0);
  return Math.round(sum / SCORE_KEYS.length);
}
