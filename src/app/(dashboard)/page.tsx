import { Suspense } from "react";
import { MomentFeed } from "@/components/MomentFeed";

export default function DiscoverPage() {
  return (
    <Suspense fallback={null}>
      <MomentFeed
        view="discover"
        heading="Discover"
        subheading="Freshly discovered moments, waiting for you to review."
        emptyMessage="Nothing new yet — run discovery or wait for the next scheduled pass."
        defaultSortBy="recently_discovered"
        bigNumberBanner
      />
    </Suspense>
  );
}
