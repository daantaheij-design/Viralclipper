import type { CropKeyframe, NormalizedBBox, TrackedKeyframe, VideoInfo } from "./types";

const TARGET_ASPECT = 9 / 16;
const SAMPLE_INTERVAL_SECONDS = 0.5;
// Cap how fast the crop window is allowed to pan, as a fraction of the crop
// window's own size per second — keeps the pan "smooth, slow enough to feel
// natural, not distracting" per spec, instead of jump-cutting to a new target.
const MAX_PAN_FRACTION_PER_SECOND = 0.5;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** libx264 requires even width/height. */
function toEven(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

/** The crop window's fixed size (only x or y pans, never both — see below). */
export function computeCropSize(source: VideoInfo): { w: number; h: number; pansHorizontally: boolean } {
  const sourceAspect = source.width / source.height;
  if (sourceAspect > TARGET_ASPECT) {
    // Wider than 9:16 (typical landscape dashcam footage) — crop a portrait
    // slice out of the full-height frame and pan it left/right.
    const w = Math.round(source.height * TARGET_ASPECT);
    return { w: toEven(Math.min(w, source.width)), h: toEven(source.height), pansHorizontally: true };
  }
  // Taller/narrower than 9:16 — crop full width, pan up/down.
  const h = Math.round(source.width / TARGET_ASPECT);
  return { w: toEven(source.width), h: toEven(Math.min(h, source.height)), pansHorizontally: false };
}

function unionBBox(a: NormalizedBBox, b: NormalizedBBox): NormalizedBBox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function centerOf(box: NormalizedBBox): { cx: number; cy: number } {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

/**
 * Turns per-instant subject bounding boxes into a smoothed 9:16 pan path in
 * source-pixel coordinates. Keeps the crop's non-panning dimension at the
 * source's full extent (no vertical AND horizontal panning at once — that
 * reads as random camera shake, not intentional framing), and never zooms:
 * the crop window is always the same size, only its position moves.
 */
export function computeSmartCropKeyframes(
  source: VideoInfo,
  durationSeconds: number,
  tracked: TrackedKeyframe[],
): CropKeyframe[] {
  const { w: cropW, h: cropH, pansHorizontally } = computeCropSize(source);
  const maxX = Math.max(source.width - cropW, 0);
  const maxY = Math.max(source.height - cropH, 0);

  const sorted = [...tracked].sort((a, b) => a.timeSeconds - b.timeSeconds);

  // Desired (unsmoothed) pan position at each tracked instant.
  const targets = sorted.map((k) => {
    let cx = 0.5;
    let cy = 0.5;
    if (k.primary && k.secondary) {
      ({ cx, cy } = centerOf(unionBBox(k.primary, k.secondary)));
    } else if (k.primary) {
      ({ cx, cy } = centerOf(k.primary));
    }
    const targetX = clamp(cx * source.width - cropW / 2, 0, maxX);
    const targetY = clamp(cy * source.height - cropH / 2, 0, maxY);
    return { timeSeconds: k.timeSeconds, x: targetX, y: targetY };
  });

  const centerFallback = { x: clamp(source.width / 2 - cropW / 2, 0, maxX), y: clamp(source.height / 2 - cropH / 2, 0, maxY) };

  function targetAt(t: number): { x: number; y: number } {
    if (targets.length === 0) return centerFallback;
    if (t <= targets[0].timeSeconds) return targets[0];
    if (t >= targets[targets.length - 1].timeSeconds) return targets[targets.length - 1];
    for (let i = 0; i < targets.length - 1; i++) {
      const a = targets[i];
      const b = targets[i + 1];
      if (t >= a.timeSeconds && t <= b.timeSeconds) {
        const span = b.timeSeconds - a.timeSeconds;
        const frac = span === 0 ? 0 : (t - a.timeSeconds) / span;
        return { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac };
      }
    }
    return centerFallback;
  }

  const maxStep = Math.max(cropW, cropH) * MAX_PAN_FRACTION_PER_SECOND * SAMPLE_INTERVAL_SECONDS;
  const keyframes: CropKeyframe[] = [];
  let current = targetAt(0);

  for (let t = 0; t <= durationSeconds + 1e-6; t += SAMPLE_INTERVAL_SECONDS) {
    const desired = targetAt(Math.min(t, durationSeconds));
    const dx = pansHorizontally ? clamp(desired.x - current.x, -maxStep, maxStep) : 0;
    const dy = pansHorizontally ? 0 : clamp(desired.y - current.y, -maxStep, maxStep);
    current = {
      x: pansHorizontally ? clamp(current.x + dx, 0, maxX) : centerFallback.x,
      y: pansHorizontally ? centerFallback.y : clamp(current.y + dy, 0, maxY),
    };
    keyframes.push({
      timeSeconds: Math.round(t * 100) / 100,
      x: Math.round(current.x),
      y: Math.round(current.y),
      w: cropW,
      h: cropH,
    });
  }

  return keyframes;
}
