import type { TikTokVersionStatus } from "@/generated/prisma";

/**
 * What the preview player / dashboard card should show for a moment's 9:16
 * render, derived from the persisted TikTokVersion status alone — pure, no
 * I/O, so it's directly unit-testable. "attempting" is the only
 * non-terminal state: the caller should try to actually play the video and
 * fall back to "media_missing" if that live attempt fails (a 404 from
 * /api/media/, e.g. a race between this status and the object actually
 * disappearing) — see VerticalPlayer.tsx.
 */
export type RenderDisplayState =
  | "no_render" // never rendered (below score threshold, or not processed yet)
  | "processing" // queued or actively rendering
  | "attempting" // status says ready — try to play it
  | "media_missing" // was ready, storage object is gone
  | "render_failed" // a render attempt failed for a reason other than a missing object
  | "source_unavailable"; // the underlying source video itself can't be downloaded

export function deriveRenderDisplayState(
  status: TikTokVersionStatus | null | undefined,
): RenderDisplayState {
  switch (status) {
    case null:
    case undefined:
      return "no_render";
    case "queued":
    case "processing":
      return "processing";
    case "ready":
      return "attempting";
    case "media_missing":
      return "media_missing";
    case "failed":
      return "render_failed";
    case "unavailable":
      return "source_unavailable";
  }
}

/** Whether "Re-render 9:16" makes sense to offer for this state. */
export function canRerender(state: RenderDisplayState): boolean {
  return state === "media_missing" || state === "render_failed" || state === "source_unavailable";
}

export const RENDER_STATE_MESSAGE: Partial<Record<RenderDisplayState, string>> = {
  media_missing: "This render is no longer available.",
  render_failed: "The 9:16 render failed.",
  source_unavailable: "The source video is no longer available for download.",
};

export const RENDER_STATE_BADGE: Partial<Record<RenderDisplayState, { label: string; className: string }>> = {
  processing: { label: "Processing 9:16…", className: "text-amber-300" },
  media_missing: { label: "RENDER MISSING", className: "text-red-300" },
  render_failed: { label: "RENDER FAILED", className: "text-red-300" },
};

/** The shape both the rerender API route and the client expect back from a repair attempt. */
export interface RerenderOutcome {
  outcome: string;
  message?: string;
  errorKind?: string;
}
