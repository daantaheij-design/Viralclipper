import { Suspense } from "react";
import { MomentFeed } from "@/components/MomentFeed";

export default function RejectedPage() {
  return (
    <Suspense fallback={null}>
      <MomentFeed
        view="rejected"
        heading="Rejected"
        emptyMessage="Nothing rejected yet."
        defaultSortBy="newest"
      />
    </Suspense>
  );
}
