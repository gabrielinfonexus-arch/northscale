"use client";
import "react-day-picker/style.css";
import { useMemo, useState } from "react";
import { DayPicker, type DateRange as RdpRange } from "react-day-picker";
import { CalendarDays } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  COMPARE_MODES,
  PRESETS,
  comparisonRange,
  parseIso,
  presetRange,
  toIso,
  type CompareMode,
  type DateRange,
  type Preset,
} from "@/lib/periods";
import { cn } from "@/lib/utils";
import { useUrlState } from "./use-url-state";

const usDate = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
const short = (r: DateRange) => (r.from === r.to ? usDate(r.from) : `${usDate(r.from)} – ${usDate(r.to)}`);
const toRdp = (r: DateRange | null): RdpRange | undefined => (r ? { from: parseIso(r.from), to: parseIso(r.to) } : undefined);
/** react-day-picker gives local-midnight dates; read their calendar fields. */
const fromLocal = (d: Date) => toIso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
const localOf = (s: string) => {
  const d = parseIso(s);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export interface DateRangePickerProps {
  today: string;
  preset: Preset;
  range: DateRange;
  compare: CompareMode;
  compareRange: DateRange | null;
}

export function DateRangePicker(props: DateRangePickerProps) {
  const { set } = useUrlState();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<Preset>(props.preset);
  const [range, setRange] = useState<DateRange>(props.range);
  const [compare, setCompare] = useState<CompareMode>(props.compare);
  const [customCmp, setCustomCmp] = useState<DateRange | null>(props.compare === "custom" ? props.compareRange : null);
  const [editing, setEditing] = useState<"main" | "compare">("main");
  const [draft, setDraft] = useState<RdpRange | undefined>(undefined);

  const cmpPreview = useMemo(
    () => comparisonRange(range, compare === "custom" && !customCmp ? "previous" : compare, customCmp),
    [range, compare, customCmp],
  );

  const reset = () => {
    setPreset(props.preset);
    setRange(props.range);
    setCompare(props.compare);
    setCustomCmp(props.compare === "custom" ? props.compareRange : null);
    setEditing("main");
    setDraft(undefined);
  };

  const apply = () => {
    const custom = preset === "custom";
    set({
      preset: custom ? "custom" : preset === "last_30" ? null : preset,
      from: custom ? range.from : null,
      to: custom ? range.to : null,
      cmp: compare === "previous" ? null : compare,
      cfrom: compare === "custom" && customCmp ? customCmp.from : null,
      cto: compare === "custom" && customCmp ? customCmp.to : null,
    });
    setOpen(false);
  };

  const onPick = (r: RdpRange | undefined) => {
    setDraft(r);
    if (!r?.from) return;
    const next = { from: fromLocal(r.from), to: fromLocal(r.to ?? r.from) };
    if (editing === "main") {
      setPreset("custom");
      setRange(next);
    } else {
      setCustomCmp(next);
    }
  };

  const shown = editing === "main" ? range : (customCmp ?? cmpPreview);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="date-range"
          className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] hover:bg-accent"
        >
          <CalendarDays className="size-3.5 text-muted" />
          <span className="num font-medium">{short(props.range)}</span>
          {props.compareRange && <span className="num hidden text-xs text-muted md:inline">vs {short(props.compareRange)}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(calc(100vw-24px),720px)] p-0">
        <div className="flex flex-col md:flex-row">
          <ul className="flex flex-wrap gap-1 border-b border-border p-2 md:w-40 md:flex-col md:flex-nowrap md:border-b-0 md:border-r">
            {PRESETS.map((p) => (
              <li key={p.value}>
                <button
                  type="button"
                  onClick={() => {
                    setEditing("main");
                    setDraft(undefined);
                    setPreset(p.value);
                    if (p.value !== "custom") setRange(presetRange(p.value, props.today));
                  }}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent",
                    preset === p.value && "bg-accent font-medium",
                  )}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex-1 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setEditing("main");
                  setDraft(undefined);
                }}
                className={cn(
                  "rounded-md border px-2 py-1",
                  editing === "main" ? "border-primary text-foreground" : "border-border text-muted",
                )}
              >
                Period <span className="num ml-1 font-medium">{short(range)}</span>
              </button>
              {cmpPreview && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing("compare");
                    setCompare("custom");
                    setCustomCmp(customCmp ?? cmpPreview);
                    setDraft(undefined);
                  }}
                  className={cn(
                    "rounded-md border px-2 py-1",
                    editing === "compare" ? "border-primary text-foreground" : "border-border text-muted",
                  )}
                >
                  Compare <span className="num ml-1 font-medium">{short(cmpPreview)}</span>
                </button>
              )}
            </div>
            <DayPicker
              mode="range"
              numberOfMonths={2}
              selected={draft ?? toRdp(shown)}
              onSelect={onPick}
              defaultMonth={localOf(shown?.from ?? props.range.from)}
              disabled={{ after: localOf(props.today) }}
              weekStartsOn={1}
              className="text-[13px] [--rdp-accent-color:var(--primary)] [--rdp-accent-background-color:var(--accent)] [--rdp-day-height:32px] [--rdp-day-width:32px] [--rdp-day_button-height:30px] [--rdp-day_button-width:30px]"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <span className="text-xs text-muted">Compare to</span>
              {COMPARE_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    setCompare(m.value);
                    if (m.value === "custom") {
                      setCustomCmp(customCmp ?? cmpPreview);
                      setEditing("compare");
                    } else setEditing("main");
                    setDraft(undefined);
                  }}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    compare === m.value ? "border-primary bg-accent font-medium" : "border-border text-muted hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={apply} data-testid="date-apply">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
