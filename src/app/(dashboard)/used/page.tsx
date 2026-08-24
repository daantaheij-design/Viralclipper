import { Suspense } from "react";
import { MomentFeed } from "@/components/MomentFeed";

export default function UsedPage() {
  return (
    <Suspense fallback={null}>
      <MomentFeed
        view="used"
        heading="Used"
        emptyMessage="Clips you mark as used show up here, so they never get suggested again."
        defaultSortBy="newest"
      />
    </Suspense>
  );
}
