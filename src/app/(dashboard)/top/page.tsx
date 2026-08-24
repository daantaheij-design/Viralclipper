import { Suspense } from "react";
import { MomentFeed } from "@/components/MomentFeed";

export default function TopClipsPage() {
  return (
    <Suspense fallback={null}>
      <MomentFeed
        view="top"
        heading="Top Clips"
        emptyMessage="No clips yet — check back after the next discovery run."
        defaultSortBy="viral_score"
        showSinceFilter
      />
    </Suspense>
  );
}
