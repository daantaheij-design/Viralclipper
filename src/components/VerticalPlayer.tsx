"use client";

import { useState } from "react";
import { formatDuration, formatTimestamp } from "@/lib/format";
import { canRerender, deriveRenderDisplayState, RENDER_STATE_MESSAGE } from "@/lib/playerState";
import type { RerenderOutcome } from "@/lib/playerState";
import type { MomentWithRelations } from "./types";

function youtubeEmbedUrl(sourceVideoId: string, startSeconds: number): string {
  return `https://www.youtube.com/embed/${sourceVideoId}?start=${Math.floor(startSeconds)}&autoplay=1`;
}

interface VerticalPlayerProps {
  moment: MomentWithRelations;
  onClose: () => void;
  onRerender: (id: string) => Promise<RerenderOutcome>;
}

export function VerticalPlayer({ moment, onClose, onRerender }: VerticalPlayerProps) {
  const [videoError, setVideoError] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  const [rerenderMessage, setRerenderMessage] = useState<string | null>(null);

  const rawState = deriveRenderDisplayState(moment.tikTokVersion?.status);
  // A live playback failure (e.g. the object disappeared after this page was
  // loaded, or the status was stale) presents the same as a known-missing
  // render rather than spinning forever.
  const displayState = rawState === "attempting" && videoError ? "media_missing" : rawState;

  const [tab, setTab] = useState<"tiktok" | "original">(
    displayState === "attempting" || displayState === "processing" ? "tiktok" : "original",
  );
  const duration = moment.endSeconds - moment.startSeconds;
  const isYouTube = moment.sourceVideo.source.name === "youtube";

  async function handleRerenderClick() {
    setRerendering(true);
    setRerenderMessage(null);
    try {
      const result = await onRerender(moment.id);
      if (result.outcome === "rendered") {
        setVideoError(false);
        setRerenderMessage(null);
      } else {
        setRerenderMessage(result.message ?? "Re-render did not complete — see the clip card for details.");
      }
    } finally {
      setRerendering(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex gap-1 rounded-lg bg-surface-2 p-1 text-sm">
            <button
              onClick={() => setTab("tiktok")}
              className={`rounded-md px-3 py-1 font-medium transition ${
                tab === "tiktok" ? "bg-accent text-white" : "text-muted hover:text-foreground"
              }`}
            >
              TikTok
            </button>
            <button
              onClick={() => setTab("original")}
              className={`rounded-md px-3 py-1 font-medium transition ${
                tab === "original" ? "bg-accent text-white" : "text-muted hover:text-foreground"
              }`}
            >
              Original
            </button>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex items-center justify-center bg-black">
          {tab === "tiktok" ? (
            displayState === "attempting" ? (
              <video
                key={`${moment.id}-${moment.tikTokVersion?.storageKey ?? ""}`}
                src={`/api/media/${moment.id}`}
                controls
                autoPlay
                muted
                playsInline
                onError={() => setVideoError(true)}
                className="aspect-9/16 max-h-[65vh] w-full bg-black"
              />
            ) : displayState === "processing" ? (
              <div className="flex aspect-9/16 max-h-[65vh] w-full flex-col items-center justify-center gap-2 bg-surface-2 text-sm text-muted">
                <span>Rendering 9:16…</span>
              </div>
            ) : (
              <div className="flex aspect-9/16 max-h-[65vh] w-full flex-col items-center justify-center gap-3 bg-surface-2 p-6 text-center text-sm text-muted">
                <span>{RENDER_STATE_MESSAGE[displayState] ?? "No 9:16 render yet."}</span>
                {canRerender(displayState) && (
                  <button
                    onClick={handleRerenderClick}
                    disabled={rerendering}
                    className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {rerendering ? "Re-rendering…" : "Re-render 9:16"}
                  </button>
                )}
                {rerenderMessage && <span className="text-xs text-red-300">{rerenderMessage}</span>}
              </div>
            )
          ) : isYouTube ? (
            <iframe
              key={moment.id}
              src={youtubeEmbedUrl(moment.sourceVideo.sourceVideoId, moment.startSeconds)}
              allow="autoplay; encrypted-media"
              allowFullScreen
              className="aspect-video max-h-[65vh] w-full bg-black"
            />
          ) : (
            <a
              href={moment.sourceVideo.url}
              target="_blank"
              rel="noreferrer"
              className="flex aspect-video w-full items-center justify-center bg-surface-2 text-sm text-accent underline"
            >
              Open original source ↗
            </a>
          )}
        </div>

        <div className="grid grid-cols-4 gap-2 border-t border-border px-4 py-3 text-center text-xs">
          <div>
            <div className="text-muted">START</div>
            <div className="font-mono font-medium">{formatTimestamp(moment.startSeconds)}</div>
          </div>
          <div>
            <div className="text-muted">PEAK</div>
            <div className="font-mono font-medium">{formatTimestamp(moment.peakSeconds)}</div>
          </div>
          <div>
            <div className="text-muted">END</div>
            <div className="font-mono font-medium">{formatTimestamp(moment.endSeconds)}</div>
          </div>
          <div>
            <div className="text-muted">DURATION</div>
            <div className="font-medium">{formatDuration(duration)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
