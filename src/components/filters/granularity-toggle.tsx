"use client";
import type { Granularity } from "@/lib/periods";
import { cn } from "@/lib/utils";
import { useUrlState } from "./use-url-state";

const OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

export function GranularityToggle({ value }: { value: Granularity }) {
  const { set } = useUrlState();
  return (
    <div role="radiogroup" aria-label="Granularity" className="flex h-8 items-center rounded-lg border border-border bg-surface p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => set({ gran: o.value === "day" ? null : o.value })}
          className={cn(
            "h-full rounded-md px-2.5 text-xs text-muted transition-colors hover:text-foreground",
            value === o.value && "bg-[#eef0f7] font-medium text-primary dark:bg-accent",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
