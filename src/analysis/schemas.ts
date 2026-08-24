import { z } from "zod";

export const CATEGORY_VALUES = [
  "road_rage",
  "dashcam",
  "instant_karma",
  "crazy_driving",
  "near_misses",
  "crashes",
  "confrontations",
  "arguments",
  "fails",
  "funny_moments",
  "unexpected_moments",
  "satisfying_moments",
  "shocking_moments",
  "weird_moments",
  "general_viral",
] as const;

export const CategorySchema = z.enum(CATEGORY_VALUES);

export const BBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

// --- Pass 1: broad scan -----------------------------------------------------

export const CandidateWindowSchema = z.object({
  startSeconds: z.number().min(0),
  endSeconds: z.number().min(0),
  reason: z
    .string()
    .describe("Why this window might contain a viral moment, in a few words"),
});

export const QuickScanResultSchema = z.object({
  candidateWindows: z
    .array(CandidateWindowSchema)
    .describe(
      "Generously padded windows (include setup and reaction, not just the peak instant) that might contain a viral moment. Empty array if nothing in this batch of frames looks promising.",
    ),
});
export type QuickScanResult = z.infer<typeof QuickScanResultSchema>;

// --- Pass 2: detailed moment analysis --------------------------------------

export const ScoresSchema = z.object({
  hook: z.number().min(0).max(100),
  visual_action: z.number().min(0).max(100),
  conflict: z.number().min(0).max(100),
  escalation: z.number().min(0).max(100),
  surprise: z.number().min(0).max(100),
  emotion: z.number().min(0).max(100),
  payoff: z.number().min(0).max(100),
  understandability: z.number().min(0).max(100),
  retention: z.number().min(0).max(100),
  rewatch: z.number().min(0).max(100),
  tiktok_suitability: z.number().min(0).max(100),
});
export type Scores = z.infer<typeof ScoresSchema>;

export const TrackedKeyframeSchema = z.object({
  time_seconds: z.number(),
  primary: BBoxSchema.optional().describe("Bounding box of the main subject to keep in frame"),
  secondary: BBoxSchema.optional().describe(
    "Bounding box of a second subject needed to understand the interaction, if any",
  ),
});

export const DetectedMomentSchema = z.object({
  title: z.string().max(80),
  category: CategorySchema,
  description: z
    .string()
    .describe("Observable-only description of what happens — never guess intent or feelings"),
  reason: z.string().describe("Why this moment would make viewers keep watching"),
  start_seconds: z.number().min(0),
  peak_seconds: z.number().min(0),
  end_seconds: z.number().min(0),
  confidence: z.number().min(0).max(1),
  scores: ScoresSchema,
  tracked_keyframes: z
    .array(TrackedKeyframeSchema)
    .max(8)
    .describe(
      "3-8 instants across the moment (start, peak, end and a few in between) with bounding boxes of the subject(s) to keep framed, for smart vertical cropping",
    ),
});
export type DetectedMoment = z.infer<typeof DetectedMomentSchema>;

export const DetailedAnalysisResultSchema = z.object({
  interesting_moment: z.boolean(),
  moments: z
    .array(DetectedMomentSchema)
    .max(3)
    .describe(
      "Usually one moment. More than one only if this window actually contains multiple distinct viral moments back to back.",
    ),
});
export type DetailedAnalysisResult = z.infer<typeof DetailedAnalysisResultSchema>;

export const OBSERVABLE_ONLY_RULE =
  "Describe only what is visually and audibly observable. Never assert intent, " +
  'emotion, or motive ("the driver wanted to cause an accident") — describe the ' +
  'observable action instead ("the driver swerves into the adjacent lane while ' +
  'the other car is alongside it").';
