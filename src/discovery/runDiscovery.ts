import { prisma } from "@/database/client";
import { getSettings } from "@/database/settings";
import { getSource } from "@/sources/registry";
import { computePreliminaryScore } from "./candidateScoring";
import { computeCategoryPrefilter } from "./categoryPrefilter";
import { checkDuplicate, titleFingerprint } from "./deduplication";
import { markQueryUsed, pickQueriesForRun } from "./queryGenerator";
import { logError } from "@/lib/errorLog";

const QUERIES_PER_SOURCE_PER_RUN = 12;
const RESULTS_PER_QUERY = 25;

export interface DiscoveryRunSummary {
  discoveryRunId: string;
  candidatesFound: number;
  uniqueCandidates: number;
  duplicatesSkipped: number;
  rejectedByCategory: number;
}

export async function runDiscovery(): Promise<DiscoveryRunSummary> {
  const settings = await getSettings();
  const categories = settings.enabledCategories;

  const run = await prisma.discoveryRun.create({ data: { status: "running" } });

  let candidatesFound = 0;
  let uniqueCandidates = 0;
  let duplicatesSkipped = 0;
  let queriesUsed = 0;
  let rejectedByCategoryCount = 0;

  try {
    const sources = await prisma.source.findMany({ where: { enabled: true } });

    for (const sourceRow of sources) {
      if (categories.length === 0) continue;
      const source = getSource(sourceRow.name);

      let queries;
      try {
        queries = await pickQueriesForRun(
          sourceRow.id,
          sourceRow.name,
          categories,
          QUERIES_PER_SOURCE_PER_RUN,
        );
      } catch (err) {
        await logError("discovery", `Failed to pick queries for ${sourceRow.name}`, err);
        continue;
      }

      for (const query of queries) {
        if (candidatesFound >= settings.candidatesPerRun) break;

        queriesUsed++;
        try {
          const results = await source.searchVideos(query.text, {
            limit: RESULTS_PER_QUERY,
            category: query.category,
          });
          await markQueryUsed(query.id);
          candidatesFound += results.length;

          for (const video of results) {
            const dedup = await checkDuplicate({
              sourceName: sourceRow.name,
              sourceVideoId: video.sourceVideoId,
              title: video.title,
              durationSeconds: video.durationSeconds,
              category: query.category,
            });
            if (dedup.isDuplicate) {
              duplicatesSkipped++;
              continue;
            }

            const { score, viewVelocity } = computePreliminaryScore(video, query.category);
            const prefilter = computeCategoryPrefilter(video, query.category);
            const rejectedByCategory = prefilter.score < settings.minPreCategoryRelevanceScore;

            try {
              const created = await prisma.sourceVideo.create({
                data: {
                  sourceId: sourceRow.id,
                  sourceVideoId: video.sourceVideoId,
                  url: video.url,
                  title: video.title,
                  description: video.description,
                  thumbnailUrl: video.thumbnailUrl,
                  channelName: video.channelName,
                  channelId: video.channelId,
                  durationSeconds: video.durationSeconds,
                  uploadDate: video.uploadDate,
                  viewCount: video.viewCount,
                  likeCount: video.likeCount,
                  commentCount: video.commentCount,
                  category: query.category,
                  discoveryQueryId: query.id,
                  discoveryRunId: run.id,
                  preliminaryScore: score,
                  viewVelocity,
                  titleFingerprint: titleFingerprint(video.title),
                  preCategoryRelevanceScore: prefilter.score,
                  categoryPrefilterReason: prefilter.reason,
                  // Rejected here, before acquisition, before any Anthropic
                  // call — see src/discovery/categoryPrefilter.ts and
                  // requirement #5/#18 of the cost-control PR.
                  status: rejectedByCategory ? "filtered_out" : "discovered",
                },
              });
              uniqueCandidates++;
              if (rejectedByCategory) rejectedByCategoryCount++;
              void created;
            } catch (err) {
              // Unique constraint hit (source, sourceVideoId) already seen
              // in a previous run — not an error, just an already-known video.
              duplicatesSkipped++;
              void err;
            }
          }
        } catch (err) {
          await logError("discovery", `Search failed for ${sourceRow.name}: "${query.text}"`, err);
        }
      }
    }

    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        queriesUsed,
        candidatesFound,
        uniqueCandidates,
        duplicatesSkipped,
        stats: { categories, sourcesSearched: sources.map((s) => s.name), rejectedByCategory: rejectedByCategoryCount },
      },
    });
  } catch (err) {
    await logError("discovery", "Discovery run failed", err);
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return {
    discoveryRunId: run.id,
    candidatesFound,
    uniqueCandidates,
    duplicatesSkipped,
    rejectedByCategory: rejectedByCategoryCount,
  };
}
