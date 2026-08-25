-- CreateEnum
CREATE TYPE "AiReservationStatus" AS ENUM ('reserved', 'committed', 'released');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoProcessingStatus" ADD VALUE 'dirty_lead';
ALTER TYPE "VideoProcessingStatus" ADD VALUE 'waiting_for_ai';

-- AlterTable
ALTER TABLE "api_usage" ADD COLUMN     "analysisJobId" TEXT,
ADD COLUMN     "estimatedCostUsd" DOUBLE PRECISION,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "runToken" TEXT;

-- AlterTable
ALTER TABLE "source_videos" ADD COLUMN     "categoryPrefilterReason" TEXT,
ADD COLUMN     "cleanSourceQueries" JSONB,
ADD COLUMN     "cleanlinessReason" TEXT,
ADD COLUMN     "hasArrows" BOOLEAN,
ADD COLUMN     "hasCircles" BOOLEAN,
ADD COLUMN     "hasLargeCaptions" BOOLEAN,
ADD COLUMN     "hasLargeGraphicOverlays" BOOLEAN,
ADD COLUMN     "hasSplitScreen" BOOLEAN,
ADD COLUMN     "likelyRepost" BOOLEAN,
ADD COLUMN     "preCategoryRelevanceScore" INTEGER,
ADD COLUMN     "sourceCleanlinessScore" INTEGER;

-- CreateTable
CREATE TABLE "ai_spend_reservations" (
    "id" TEXT NOT NULL,
    "status" "AiReservationStatus" NOT NULL DEFAULT 'reserved',
    "kind" TEXT NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "actualCostUsd" DOUBLE PRECISION,
    "runToken" TEXT NOT NULL,
    "sourceVideoId" TEXT,
    "momentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_spend_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_locks" (
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "holderToken" TEXT,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_locks_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "ai_spend_reservations_status_idx" ON "ai_spend_reservations"("status");

-- CreateIndex
CREATE INDEX "ai_spend_reservations_runToken_idx" ON "ai_spend_reservations"("runToken");

-- CreateIndex
CREATE INDEX "api_usage_runToken_idx" ON "api_usage"("runToken");

-- Force-reset any already-persisted discovery_settings row to the new safe
-- production defaults, regardless of what was previously saved. This is
-- deliberate, not incidental: the production incident this migration exists
-- to prevent was caused by settings that were already live (automatic
-- discovery on, a $5 daily budget, 5 quick scans / 2 detailed analyses per
-- run) with no hard spend cap enforcing them. A code-level default only
-- applies when no row exists yet, which would leave an existing
-- installation's dangerous values in place — so overwrite them explicitly
-- here, once, on this migration. Paid AI Analysis has no old key to
-- preserve (it's a brand new field), so it already defaults to false for
-- every installation; this UPDATE makes automatic discovery and every
-- numeric cap match it. No-op if the row doesn't exist yet (fresh install).
UPDATE "app_settings"
SET "value" = "value"
    || '{
      "automaticDiscoveryEnabled": false,
      "paidAiAnalysisEnabled": false,
      "dailyAiBudgetUsd": 0.5,
      "perRunAiBudgetUsd": 0.2,
      "maxConcurrentAnthropicCalls": 1,
      "maxQuickScansPerRun": 1,
      "maxDetailedAnalysesPerRun": 1,
      "maxRendersPerRun": 1,
      "minSourceCleanlinessScore": 75,
      "minPreCategoryRelevanceScore": 70
    }'::jsonb
WHERE "key" = 'discovery_settings';
