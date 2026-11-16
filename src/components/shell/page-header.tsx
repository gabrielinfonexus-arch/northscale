import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRangePicker } from "@/components/filters/date-range-picker";
import { GranularityToggle } from "@/components/filters/granularity-toggle";
import type { PageContext } from "@/server/page-context";

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Title + global period controls (Day/Week/Month/Year + date range with comparison). */
export function PageHeader({ title, ctx, showGranularity = true }: { title: string; ctx: PageContext; showGranularity?: boolean }) {
  const f = ctx.filters;
  return (
    <PageTitle title={title}>
      {showGranularity && <GranularityToggle value={f.granularity} />}
      <DateRangePicker today={ctx.today} preset={f.preset} range={f.range} compare={f.compare} compareRange={f.compareRange} />
    </PageTitle>
  );
}

export function PageHeaderSkeleton({ title }: { title: string }) {
  return (
    <PageTitle title={title}>
      <Skeleton className="h-8 w-[196px]" />
      <Skeleton className="h-8 w-[220px]" />
    </PageTitle>
  );
}
