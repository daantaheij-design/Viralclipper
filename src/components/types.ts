import type { Prisma } from "@/generated/prisma";

export type MomentWithRelations = Prisma.DetectedMomentGetPayload<{
  include: { sourceVideo: { include: { source: true } }; tikTokVersion: true };
}>;

export type ScoresShape = {
  hook: number;
  visual_action: number;
  conflict: number;
  escalation: number;
  surprise: number;
  emotion: number;
  payoff: number;
  understandability: number;
  retention: number;
  rewatch: number;
  tiktok_suitability: number;
};
