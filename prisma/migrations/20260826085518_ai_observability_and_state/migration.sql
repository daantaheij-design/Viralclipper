-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VideoProcessingStatus" ADD VALUE 'ai_processing';
ALTER TYPE "VideoProcessingStatus" ADD VALUE 'ai_rejected_quick';
ALTER TYPE "VideoProcessingStatus" ADD VALUE 'ai_rejected_detailed';
ALTER TYPE "VideoProcessingStatus" ADD VALUE 'ai_rejected_below_score';
ALTER TYPE "VideoProcessingStatus" ADD VALUE 'ai_failed';

-- AlterTable
ALTER TABLE "source_videos" ADD COLUMN     "paidAnalysisAttempts" INTEGER NOT NULL DEFAULT 0;
