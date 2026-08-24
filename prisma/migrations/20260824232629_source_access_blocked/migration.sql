-- AlterEnum
ALTER TYPE "VideoProcessingStatus" ADD VALUE 'source_access_blocked';

-- AlterTable
ALTER TABLE "source_videos" ADD COLUMN     "accessFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextRetryAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "source_videos_status_nextRetryAt_idx" ON "source_videos"("status", "nextRetryAt");
