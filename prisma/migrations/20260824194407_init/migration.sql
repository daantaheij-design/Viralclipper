-- CreateEnum
CREATE TYPE "SourceName" AS ENUM ('youtube', 'reddit');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('road_rage', 'dashcam', 'instant_karma', 'crazy_driving', 'near_misses', 'crashes', 'confrontations', 'arguments', 'fails', 'funny_moments', 'unexpected_moments', 'satisfying_moments', 'shocking_moments', 'weird_moments', 'general_viral');

-- CreateEnum
CREATE TYPE "VideoProcessingStatus" AS ENUM ('discovered', 'filtered_out', 'queued_for_scan', 'scanning', 'scanned', 'no_candidates', 'error');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AnalysisJobType" AS ENUM ('quick_scan', 'detailed_analysis');

-- CreateEnum
CREATE TYPE "AnalysisJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('moment_found', 'tiktok_processing', 'ready', 'saved', 'editing', 'used', 'rejected', 'no_good_moment', 'error');

-- CreateEnum
CREATE TYPE "TikTokVersionStatus" AS ENUM ('queued', 'processing', 'ready', 'failed', 'unavailable');

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "name" "SourceName" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_accounts" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_queries" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "generatedBy" TEXT NOT NULL DEFAULT 'seed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_runs" (
    "id" TEXT NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "queriesUsed" INTEGER NOT NULL DEFAULT 0,
    "candidatesFound" INTEGER NOT NULL DEFAULT 0,
    "uniqueCandidates" INTEGER NOT NULL DEFAULT 0,
    "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_videos" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "thumbnailUrl" TEXT,
    "channelName" TEXT,
    "channelId" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "uploadDate" TIMESTAMP(3),
    "viewCount" INTEGER,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "category" "Category" NOT NULL,
    "discoveryQueryId" TEXT,
    "discoveryRunId" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preliminaryScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "viewVelocity" DOUBLE PRECISION,
    "status" "VideoProcessingStatus" NOT NULL DEFAULT 'discovered',
    "errorMessage" TEXT,
    "titleFingerprint" TEXT,

    CONSTRAINT "source_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_fingerprints" (
    "id" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_jobs" (
    "id" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "type" "AnalysisJobType" NOT NULL,
    "status" "AnalysisJobStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_windows" (
    "id" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "analyzed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detected_moments" (
    "id" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "candidateWindowId" TEXT,
    "category" "Category" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "peakSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "scores" JSONB NOT NULL,
    "viralScore" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "ClipStatus" NOT NULL DEFAULT 'moment_found',
    "userNote" TEXT,
    "savedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detected_moments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_versions" (
    "id" TEXT NOT NULL,
    "momentId" TEXT NOT NULL,
    "status" "TikTokVersionStatus" NOT NULL DEFAULT 'queued',
    "storageKey" TEXT,
    "width" INTEGER NOT NULL DEFAULT 1080,
    "height" INTEGER NOT NULL DEFAULT 1920,
    "durationSeconds" DOUBLE PRECISION,
    "fps" DOUBLE PRECISION,
    "fileSizeBytes" INTEGER,
    "cropKeyframes" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "renderedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiktok_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sourceVideoId" TEXT,
    "momentId" TEXT,
    "discoveryRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "error_logs" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_name_key" ON "sources"("name");

-- CreateIndex
CREATE INDEX "search_queries_category_active_idx" ON "search_queries"("category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "search_queries_sourceId_category_text_key" ON "search_queries"("sourceId", "category", "text");

-- CreateIndex
CREATE INDEX "source_videos_status_idx" ON "source_videos"("status");

-- CreateIndex
CREATE INDEX "source_videos_category_idx" ON "source_videos"("category");

-- CreateIndex
CREATE INDEX "source_videos_titleFingerprint_idx" ON "source_videos"("titleFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "source_videos_sourceId_sourceVideoId_key" ON "source_videos"("sourceId", "sourceVideoId");

-- CreateIndex
CREATE INDEX "duplicate_fingerprints_kind_value_idx" ON "duplicate_fingerprints"("kind", "value");

-- CreateIndex
CREATE INDEX "analysis_jobs_sourceVideoId_type_idx" ON "analysis_jobs"("sourceVideoId", "type");

-- CreateIndex
CREATE INDEX "detected_moments_status_viralScore_idx" ON "detected_moments"("status", "viralScore");

-- CreateIndex
CREATE INDEX "detected_moments_category_viralScore_idx" ON "detected_moments"("category", "viralScore");

-- CreateIndex
CREATE INDEX "detected_moments_createdAt_idx" ON "detected_moments"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_versions_momentId_key" ON "tiktok_versions"("momentId");

-- CreateIndex
CREATE INDEX "api_usage_provider_createdAt_idx" ON "api_usage"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "error_logs_scope_createdAt_idx" ON "error_logs"("scope", "createdAt");

-- AddForeignKey
ALTER TABLE "source_accounts" ADD CONSTRAINT "source_accounts_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_videos" ADD CONSTRAINT "source_videos_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_videos" ADD CONSTRAINT "source_videos_discoveryQueryId_fkey" FOREIGN KEY ("discoveryQueryId") REFERENCES "search_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_videos" ADD CONSTRAINT "source_videos_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "discovery_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_fingerprints" ADD CONSTRAINT "duplicate_fingerprints_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "source_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "source_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_windows" ADD CONSTRAINT "candidate_windows_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "source_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detected_moments" ADD CONSTRAINT "detected_moments_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "source_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detected_moments" ADD CONSTRAINT "detected_moments_candidateWindowId_fkey" FOREIGN KEY ("candidateWindowId") REFERENCES "candidate_windows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_versions" ADD CONSTRAINT "tiktok_versions_momentId_fkey" FOREIGN KEY ("momentId") REFERENCES "detected_moments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
