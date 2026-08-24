-- AlterTable
ALTER TABLE "detected_moments" ADD COLUMN     "trackedKeyframes" JSONB NOT NULL DEFAULT '[]';
