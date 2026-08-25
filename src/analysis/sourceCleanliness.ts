import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { run } from "@/lib/proc";
import type { VideoInfo } from "@/video/types";

/**
 * Zero-Anthropic, zero-cost source-cleanliness gate. Deliberately contains
 * NO import from `@/ai/*` or `@/analysis/{quickScan,detailedAnalysis}` — a
 * structural test (sourceCleanliness.test.ts) asserts that, since the
 * entire point of this module is to reject obviously-unusable sources
 * (caption-heavy edited Shorts, arrow/circle-annotated reposts,
 * split-screen/reaction formats) *before* a single dollar is spent on
 * Claude vision.
 *
 * This is a deterministic heuristic, not ML-based object detection: no new
 * dependency (no OpenCV/native bindings, no image library) is added — it
 * works entirely off `ffmpeg` (already a hard dependency) piping raw,
 * heavily downscaled grayscale frames into plain Node buffer math. The
 * signal it looks for is the dominant visual signature of a heavily edited
 * Short: a screen region that is both *sharp* (high local contrast — text/
 * graphic edges) and *temporally static* (its brightness barely changes
 * across the sampled frames, unlike the moving footage under it). A small
 * corner watermark/timestamp is deliberately excluded from that check (see
 * `CORNER_CELLS`) since the spec treats those as acceptable.
 *
 * It cannot truly distinguish an arrow's shape from a circle's — both
 * surface as "a compact, sharp, static overlay outside the caption band" —
 * so `hasArrows`/`hasCircles` are set together from that one signal. This
 * is an honest scope limitation, not a bug: the goal is to catch the
 * pattern (a graphic annotation was added), not identify its exact shape.
 */

const SAMPLE_COUNT = 8;
const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 135;
const GRID_COLS = 12;
const GRID_ROWS = 9;
const CELL_W = FRAME_WIDTH / GRID_COLS;
const CELL_H = FRAME_HEIGHT / GRID_ROWS;

const EDGE_FACTOR = 1.8; // a cell counts as "sharp" once its edge energy exceeds this x the frame-set median
const MIN_ABSOLUTE_EDGE = 3; // floor (0-255 luma units) so a blank/flat clean video can't spuriously trip the relative threshold
const VARIANCE_FACTOR = 0.4; // a cell counts as "static" once its temporal luma variance is below this x the median
const CAPTION_MIN_COLS = 4; // a caption-zone overlay must span at least this many grid columns to count as "large"
const GRAPHIC_MIN_CELLS = 2; // a non-caption overlay cluster must cover at least this many cells to count (avoids single-cell noise)
const SPLIT_LUMA_THRESHOLD = 18; // 0-255 luma units of sustained left/right (or top/bottom) brightness asymmetry

export interface CleanlinessResult {
  score: number; // 0-100
  hasLargeCaptions: boolean;
  hasArrows: boolean;
  hasCircles: boolean;
  hasSplitScreen: boolean;
  hasLargeGraphicOverlays: boolean;
  likelyRepost: boolean;
  reason: string;
}

interface CellStats {
  row: number;
  col: number;
  avgEdgeEnergy: number;
  temporalVariance: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isCornerCell(row: number, col: number): boolean {
  return (row === 0 || row === GRID_ROWS - 1) && (col === 0 || col === GRID_COLS - 1);
}

function isCaptionZoneCell(row: number, col: number): boolean {
  // Bottom ~44% of the frame, excluding a small margin on each side.
  return row >= GRID_ROWS - 4 && col >= 1 && col <= GRID_COLS - 2;
}

async function extractGrayscaleSamples(filePath: string, scratchFile: string, video: VideoInfo): Promise<Buffer[]> {
  const fps = Math.max(SAMPLE_COUNT / Math.max(video.durationSeconds, 1), 0.05);
  await run(env.ffmpegPath, [
    "-i",
    filePath,
    "-vf",
    `fps=${fps},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=fast_bilinear,format=gray`,
    "-frames:v",
    String(SAMPLE_COUNT),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-threads",
    String(env.ffmpegThreads),
    scratchFile,
  ]);
  const buf = await readFile(scratchFile);
  const frameSize = FRAME_WIDTH * FRAME_HEIGHT;
  const frames: Buffer[] = [];
  for (let off = 0; off + frameSize <= buf.length; off += frameSize) {
    frames.push(buf.subarray(off, off + frameSize));
  }
  return frames;
}

/** Average gradient magnitude within one grid cell of one grayscale frame — a cheap sharpness/contrast proxy. */
function cellEdgeEnergy(frame: Buffer, row: number, col: number): number {
  const x0 = Math.floor(col * CELL_W);
  const y0 = Math.floor(row * CELL_H);
  const x1 = Math.floor((col + 1) * CELL_W);
  const y1 = Math.floor((row + 1) * CELL_H);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const p = frame[y * FRAME_WIDTH + x];
      const right = frame[y * FRAME_WIDTH + x + 1];
      const down = frame[(y + 1) * FRAME_WIDTH + x];
      sum += Math.abs(right - p) + Math.abs(down - p);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function cellMeanLuma(frame: Buffer, row: number, col: number): number {
  const x0 = Math.floor(col * CELL_W);
  const y0 = Math.floor(row * CELL_H);
  const x1 = Math.floor((col + 1) * CELL_W);
  const y1 = Math.floor((row + 1) * CELL_H);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += frame[y * FRAME_WIDTH + x];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function computeCellStats(frames: Buffer[]): CellStats[] {
  const stats: CellStats[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const edgeEnergies = frames.map((f) => cellEdgeEnergy(f, row, col));
      const lumas = frames.map((f) => cellMeanLuma(f, row, col));
      const avgEdgeEnergy = edgeEnergies.reduce((a, b) => a + b, 0) / edgeEnergies.length;
      const meanLuma = lumas.reduce((a, b) => a + b, 0) / lumas.length;
      const temporalVariance =
        lumas.reduce((a, b) => a + (b - meanLuma) ** 2, 0) / lumas.length;
      stats.push({ row, col, avgEdgeEnergy, temporalVariance });
    }
  }
  return stats;
}

function detectSplitScreen(frames: Buffer[]): boolean {
  const halfCol = Math.floor(GRID_COLS / 2);
  const diffs: number[] = [];
  for (const frame of frames) {
    let leftSum = 0;
    let rightSum = 0;
    let n = 0;
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const luma = cellMeanLuma(frame, row, col);
        if (col < halfCol) leftSum += luma;
        else rightSum += luma;
        n++;
      }
    }
    void n;
    diffs.push(leftSum / (GRID_ROWS * halfCol) - rightSum / (GRID_ROWS * (GRID_COLS - halfCol)));
  }
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const consistentSign = diffs.every((d) => Math.sign(d) === Math.sign(meanDiff) || Math.abs(d) < 2);
  return Math.abs(meanDiff) > SPLIT_LUMA_THRESHOLD && consistentSign;
}

/**
 * Runs the local cleanliness scan against an already-acquired video file.
 * Zero Anthropic calls, zero network calls — purely local ffmpeg + Node.
 */
export async function scanSourceCleanliness(
  filePath: string,
  scratchDir: string,
  video: VideoInfo,
): Promise<CleanlinessResult> {
  await mkdir(scratchDir, { recursive: true });
  const scratchFile = path.join(scratchDir, "cleanliness-samples.raw");

  try {
    const frames = await extractGrayscaleSamples(filePath, scratchFile, video);
    if (frames.length < 2) {
      // Too short/degenerate to say anything meaningful — treat as clean
      // rather than falsely penalizing (this only happens for
      // near-zero-length videos, which fail other checks anyway).
      return {
        score: 100,
        hasLargeCaptions: false,
        hasArrows: false,
        hasCircles: false,
        hasSplitScreen: false,
        hasLargeGraphicOverlays: false,
        likelyRepost: false,
        reason: "Not enough frames sampled to evaluate; treated as clean.",
      };
    }

    const cellStats = computeCellStats(frames);
    const edgeThreshold = Math.max(median(cellStats.map((c) => c.avgEdgeEnergy)) * EDGE_FACTOR, MIN_ABSOLUTE_EDGE);
    const varianceThreshold = median(cellStats.map((c) => c.temporalVariance)) * VARIANCE_FACTOR;

    const overlayCells = cellStats.filter(
      (c) => c.avgEdgeEnergy > edgeThreshold && c.temporalVariance < varianceThreshold,
    );

    const captionCells = overlayCells.filter((c) => isCaptionZoneCell(c.row, c.col));
    const captionCols = new Set(captionCells.map((c) => c.col)).size;
    const hasLargeCaptions = captionCols >= CAPTION_MIN_COLS;

    const graphicCells = overlayCells.filter(
      (c) => !isCaptionZoneCell(c.row, c.col) && !isCornerCell(c.row, c.col),
    );
    const hasGraphicOverlay = graphicCells.length >= GRAPHIC_MIN_CELLS;

    const hasSplitScreen = detectSplitScreen(frames);

    const totalCells = GRID_ROWS * GRID_COLS;
    const nonCornerOverlayRatio = overlayCells.filter((c) => !isCornerCell(c.row, c.col)).length / totalCells;

    const likelyRepost = hasLargeCaptions && (hasGraphicOverlay || hasSplitScreen);

    let score = 100;
    const reasons: string[] = [];
    if (hasLargeCaptions) {
      score -= 35;
      reasons.push("a large persistent overlay spans the lower-third caption band (caption/subtitle-like)");
    }
    if (hasGraphicOverlay) {
      score -= 30;
      reasons.push("a compact, sharp, static overlay outside the caption band and outside the corners (arrow/circle/box/emoji-like graphic annotation)");
    }
    if (hasSplitScreen) {
      score -= 35;
      reasons.push("a sustained left/right brightness split consistent with a split-screen or reaction-cam layout");
    }
    const extraCoveragePenalty = Math.round(Math.max(nonCornerOverlayRatio - 0.05, 0) * 60);
    if (extraCoveragePenalty > 0) {
      score -= extraCoveragePenalty;
      reasons.push("persistent overlays cover an unusually large portion of the frame");
    }
    if (likelyRepost) score -= 10;
    score = Math.max(0, Math.min(100, score));

    const reason =
      reasons.length > 0
        ? `${reasons.join("; ")}.`
        : "No persistent overlays detected outside small corner regions; looks like unedited source footage.";

    return {
      score,
      hasLargeCaptions,
      hasArrows: hasGraphicOverlay,
      hasCircles: hasGraphicOverlay,
      hasSplitScreen,
      hasLargeGraphicOverlays: hasGraphicOverlay,
      likelyRepost,
      reason,
    };
  } finally {
    await rm(scratchFile, { force: true });
  }
}

/**
 * Pure string generation for a "dirty lead" — no discovery/search API calls
 * made here (that's a deliberate scope boundary; see README). Just
 * suggests phrasings a human, or a future automation, could search for.
 */
export function suggestCleanSourceQueries(title: string): string[] {
  const base = title
    .replace(/#\w+/g, " ")
    .replace(/\b(shorts?|tiktok|reels?)\b/gi, " ")
    .replace(/[\[(].*?[\])]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return [];
  const suffixes = ["original", "full video", "raw footage", "original footage"];
  const queries = suffixes.map((s) => `${base} ${s}`);
  return [...new Set(queries)];
}
