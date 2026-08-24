import { Suspense } from "react";
import { MomentFeed } from "@/components/MomentFeed";

export default function SavedPage() {
  return (
    <Suspense fallback={null}>
      <MomentFeed
        view="saved"
        heading="Saved"
        emptyMessage="Nothing saved yet — clips you save from Discover or Top Clips show up here."
        defaultSortBy="newest"
      />
    </Suspense>
  );
}
