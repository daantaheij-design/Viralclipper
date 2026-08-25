"use client";

import { useState } from "react";
import {
  CATEGORY_LABELS,
  SOURCE_LABELS,
  formatCompactNumber,
  formatDuration,
  formatTimestamp,
  scoreColorClass,
} from "@/lib/format";
import { canRerender, deriveRenderDisplayState, RENDER_STATE_BADGE } from "@/lib/playerState";
import type { RerenderOutcome } from "@/lib/playerState";
import type { MomentAction, MomentView } from "@/database/moments";
import type { MomentWithRelations } from "./types";

interface ClipCardProps {
  moment: MomentWithRelations;
  view: MomentView;
  onPreview: (moment: MomentWithRelations) => void;
  onAction: (id: string, action: MomentAction) => Promise<void>;
  onReanalyze: (id: string) => Promise<void>;
  onRerender: (id: string) => Promise<RerenderOutcome>;
}

function ActionButton({
  children,
  onClick,
  variant = "default",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
}) {
  const styles = {
    default: "bg-surface-2 text-foreground hover:bg-neutral-700",
    primary: "bg-accent text-white hover:bg-orange-500",
    danger: "bg-red-950 text-red-300 hover:bg-red-900",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function ClipCard({ moment, view, onPreview, onAction, onReanalyze, onRerender }: ClipCardProps) {
  const [busy, setBusy] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const duration = moment.endSeconds - moment.startSeconds;
  const renderState = deriveRenderDisplayState(moment.tikTokVersion?.status);
  const badge = RENDER_STATE_BADGE[renderState];

  async function act(action: MomentAction) {
    setBusy(true);
    try {
      await onAction(moment.id, action);
    } finally {
      setBusy(false);
    }
  }

  async function rerender() {
    setRerendering(true);
    try {
      await onRerender(moment.id);
    } finally {
      setRerendering(false);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface transition hover:border-neutral-600">
      <button
        onClick={() => onPreview(moment)}
        className="group relative block aspect-video w-full overflow-hidden bg-surface-2"
      >
        {moment.sourceVideo.thumbnailUrl && !thumbnailFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={moment.sourceVideo.thumbnailUrl}
            alt=""
            onError={() => setThumbnailFailed(true)}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted">No thumbnail</div>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
          <span className="rounded-full bg-white/90 px-4 py-1.5 text-sm font-semibold text-black">
            ▶ Preview
          </span>
        </div>
        <div className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-xs font-medium text-white backdrop-blur">
          {CATEGORY_LABELS[moment.category]}
        </div>
        <div
          className={`absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-sm font-bold backdrop-blur ${scoreColorClass(moment.viralScore)}`}
        >
          🔥 {moment.viralScore}
        </div>
        {badge && (
          <div className={`absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-xs font-medium ${badge.className}`}>
            {badge.label}
          </div>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-1 font-semibold text-foreground">{moment.title}</h3>
        <p className="line-clamp-2 text-sm text-muted">{moment.description}</p>

        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="font-mono">
            {formatTimestamp(moment.startSeconds)} → {formatTimestamp(moment.endSeconds)}
          </span>
          <span>·</span>
          <span>{formatDuration(duration)}</span>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{SOURCE_LABELS[moment.sourceVideo.source.name]}</span>
          {moment.sourceVideo.viewCount !== null && (
            <>
              <span>·</span>
              <span>{formatCompactNumber(moment.sourceVideo.viewCount)} views</span>
            </>
          )}
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          <ActionButton variant="primary" onClick={() => onPreview(moment)}>
            Preview
          </ActionButton>
          <a
            href={moment.sourceVideo.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-neutral-700"
          >
            Source ↗
          </a>
          {renderState === "attempting" && (
            <a
              href={`/api/media/${moment.id}`}
              download
              className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-neutral-700"
            >
              Download 9:16
            </a>
          )}
          {canRerender(renderState) && (
            <ActionButton onClick={rerender} disabled={rerendering} variant="primary">
              {rerendering ? "Re-rendering…" : "Re-render 9:16"}
            </ActionButton>
          )}

          {view === "discover" || view === "top" ? (
            <>
              <ActionButton onClick={() => act("save")} disabled={busy}>
                Save
              </ActionButton>
              <ActionButton onClick={() => act("reject")} disabled={busy} variant="danger">
                Reject
              </ActionButton>
            </>
          ) : null}

          {view === "saved" ? (
            <>
              <ActionButton onClick={() => act("editing")} disabled={busy}>
                Editing
              </ActionButton>
              <ActionButton onClick={() => act("use")} disabled={busy}>
                Mark Used
              </ActionButton>
              <ActionButton onClick={() => act("reject")} disabled={busy} variant="danger">
                Reject
              </ActionButton>
            </>
          ) : null}

          {view === "used" || view === "rejected" ? (
            <ActionButton onClick={() => act("unsave")} disabled={busy}>
              Restore
            </ActionButton>
          ) : null}

          <ActionButton
            onClick={async () => {
              setBusy(true);
              try {
                await onReanalyze(moment.id);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Analyze Again
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
