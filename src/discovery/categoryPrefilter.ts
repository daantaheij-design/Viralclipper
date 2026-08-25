import type { Category } from "@/generated/prisma";
import type { DiscoveredVideo } from "@/sources/types";
import { SEED_QUERIES } from "./seedQueries";

/**
 * Cheap, local, metadata-only category gate — title/description keyword
 * matching only, no video download, no Anthropic call. Runs at discovery
 * time, before a video is even a candidate for acquisition, so obviously
 * wrong-topic content (aviation, gaming, politics, podcasts, workplace/
 * customer-service/relationship/courtroom arguments — none of which are
 * driving-incident categories this app targets) never reaches the AI
 * budget check at all. Claude still performs the real semantic category
 * confirmation later (in quickScan/detailedAnalysis's own prompts) — this
 * is only a coarse pre-filter to stop obviously-wrong content from costing
 * anything.
 */

const OBVIOUSLY_UNRELATED_PHRASES = [
  // aviation
  "air traffic control",
  "atc audio",
  "cockpit recording",
  "pilot argument",
  "airline passenger",
  "flight attendant",
  "runway incident",
  // gaming
  "gameplay",
  "let's play",
  "speedrun",
  "twitch clip",
  "minecraft",
  "fortnite",
  "video game",
  // politics
  "senate hearing",
  "parliament session",
  "election debate",
  "press briefing",
  "city council meeting",
  // podcasts / commentary
  "full podcast episode",
  "podcast clip",
  "full interview",
  // workplace / customer service
  "workplace drama",
  "office argument",
  "customer service call",
  "karen at work",
  "hr complaint",
  // relationship
  "breakup story",
  "divorce court",
  "relationship drama",
  // courtroom
  "courtroom footage",
  "judge judy",
  "small claims court",
  "trial verdict",
];

function normalizedKeywords(category: Category): string[] {
  const keywords = new Set<string>();
  for (const q of SEED_QUERIES[category] ?? []) {
    for (const word of q.toLowerCase().split(/\s+/)) {
      if (word.length > 3) keywords.add(word);
    }
  }
  return [...keywords];
}

export interface CategoryPrefilterResult {
  score: number; // 0-100
  reason: string;
}

/**
 * Scores how likely a discovered video's metadata actually matches
 * `category`. Two components: keyword-hit relevance against the category's
 * own seed-query vocabulary (same idea as candidateScoring.ts's
 * keywordRelevance, kept independent here since this is a hard gate, not a
 * ranking factor), and a heavy penalty/cap if an obviously-unrelated-topic
 * phrase appears anywhere in the title/description.
 */
export function computeCategoryPrefilter(video: DiscoveredVideo, category: Category): CategoryPrefilterResult {
  const haystack = `${video.title} ${video.description}`.toLowerCase();

  const unrelatedHit = OBVIOUSLY_UNRELATED_PHRASES.find((phrase) => haystack.includes(phrase));

  const keywords = normalizedKeywords(category);
  let hits = 0;
  for (const word of keywords) {
    if (haystack.includes(word)) hits++;
  }
  const relevance = keywords.length > 0 ? Math.min(hits / Math.min(keywords.length, 6), 1) : 0.5;
  let score = Math.round(relevance * 100);

  if (unrelatedHit) {
    score = Math.min(score, 15);
    return {
      score,
      reason: `Title/description contains an unrelated-topic phrase ("${unrelatedHit}") that doesn't match any driving-incident category.`,
    };
  }

  return {
    score,
    reason: `Keyword relevance to "${category}": ${score}/100 (${hits} matching term${hits === 1 ? "" : "s"} in title/description).`,
  };
}
