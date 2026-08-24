"use client";

import { useState } from "react";
import { formatDuration, formatTimestamp } from "@/lib/format";
import type { MomentWithRelations } from "./types";

function youtubeEmbedUrl(sourceVideoId: string, startSeconds: number): string {
  return `https://www.youtube.com/embed/${sourceVideoId}?start=${Math.floor(startSeconds)}&autoplay=1`;
}

export function VerticalPlayer({ moment, onClose }: { moment: MomentWithRelations; onClose: () => void }) {
  const tiktokReady = moment.tikTokVersion?.status === "ready";
  const [tab, setTab] = useState<"tiktok" | "original">(tiktokReady ? "tiktok" : "original");
  const duration = moment.endSeconds - moment.startSeconds;
  const isYouTube = moment.sourceVideo.source.name === "youtube";

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
              disabled={!tiktokReady}
              className={`rounded-md px-3 py-1 font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
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
          {tab === "tiktok" && tiktokReady ? (
            <video
              key={moment.id}
              src={`/api/media/${moment.id}`}
              controls
              autoPlay
              muted
              playsInline
              className="aspect-9/16 max-h-[65vh] w-full bg-black"
            />
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
