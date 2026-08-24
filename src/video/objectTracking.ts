import type { TrackedKeyframe } from "./types";

/**
 * Turns per-instant subject positions into `TrackedKeyframe[]` that
 * `smartCrop.ts` can pan a 9:16 window across. Kept as a swappable
 * interface (per the project brief) so a real CV detector/tracker can
 * replace the Claude-vision-derived implementation later without touching
 * `smartCrop.ts` or the renderer.
 */
export interface ObjectTracker {
  readonly name: string;
  track(input: { rawKeyframes: unknown }): TrackedKeyframe[];
}

/**
 * The default (and currently only) tracker: pass-2 vision analysis already
 * looks at every dense frame in the moment window to write its
 * description/scores, so it also reports where the main subject(s) are at
 * a handful of those same instants — no extra AI call or CV pass needed.
 * This just validates/normalizes that persisted JSON.
 */
export const claudeVisionTracker: ObjectTracker = {
  name: "claude_vision_keyframes",
  track({ rawKeyframes }): TrackedKeyframe[] {
    if (!Array.isArray(rawKeyframes)) return [];
    return rawKeyframes
      .filter(
        (k): k is TrackedKeyframe =>
          typeof k === "object" && k !== null && typeof (k as TrackedKeyframe).timeSeconds === "number",
      )
      .map((k) => ({
        timeSeconds: k.timeSeconds,
        primary: k.primary,
        secondary: k.secondary,
      }));
  },
};
