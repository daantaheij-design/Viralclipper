/** A normalized (0..1) bounding box in source-frame coordinates. */
export interface NormalizedBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the subject(s) worth framing are at one instant, clip-relative seconds. */
export interface TrackedKeyframe {
  timeSeconds: number;
  primary?: NormalizedBBox;
  secondary?: NormalizedBBox;
}

/** One point in the final 9:16 pan path, in source-pixel coordinates. */
export interface CropKeyframe {
  timeSeconds: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoInfo {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}
