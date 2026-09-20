import { PageHeaderSkeleton, ChampionsDashboardSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="py-8">
      <PageHeaderSkeleton />
      <ChampionsDashboardSkeleton count={18} />
    </div>
  );
}
