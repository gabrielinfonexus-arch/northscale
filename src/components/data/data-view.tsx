"use client";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ColumnVisibilityState as VisibilityState } from "@tanstack/react-table";
import { AlertTriangle, Columns3, Download, Info, LayoutGrid, Rows3, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUrlState } from "@/components/filters/use-url-state";
import { PLATFORM_TABS, SUB_TABS, type DataPlatform } from "@/lib/data-tabs";
import { METRIC_MAP } from "@/lib/metrics";
import { savePreference } from "@/server/actions";
import type { DataRow, DataTableModel } from "@/server/data/types";
import { cn } from "@/lib/utils";
import { DataTable, columnValue, headerLabel } from "./data-table";
import { SegmentCharts } from "./segment-charts";
import { Heatmap } from "./heatmap";
import { CreativeDialog, CreativesGrid } from "./creatives-grid";

export interface DataViewProps {
  model: DataTableModel;
  platform: DataPlatform;
  tab: string;
  savedColumns: string[] | null;
  clientId: string;
  clientSlug: string;
  range: { from: string; to: string };
  threshold: number;
  campaign: string | null;
  campaigns: { id: string; name: string }[];
}

function visibilityFrom(model: DataTableModel, visible: string[]): VisibilityState {
  const set = new Set(visible);
  return Object.fromEntries(model.columns.map((c) => [c.id, set.has(c.id)]));
}

function toCsv(model: DataTableModel, rows: DataRow[], visible: string[]): string {
  const cols = model.columns.filter((c) => visible.includes(c.id) && c.kind !== "thumb");
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    model.firstColumn,
    ...cols.map((c) => (c.metric ? `${METRIC_MAP[c.metric]?.label ?? headerLabel(c)}${c.kind === "share" ? " %" : ""}` : headerLabel(c))),
  ];
  const line = (r: DataRow) => [r.label, ...cols.map((c) => columnValue(c, r, model.total))].map(esc).join(",");
  return [header.map(esc).join(","), ...rows.map(line), line({ id: "total", label: "Total", totals: model.total })].join("\n");
}

export function DataView(p: DataViewProps) {
  const { model } = p;
  const { sp, set, pending } = useUrlState();
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState<string[]>(
    () => p.savedColumns?.filter((id) => model.columns.some((c) => c.id === id)) ?? model.defaultVisible,
  );
  const [view, setView] = useState<"grid" | "table">(model.view === "creatives" ? "grid" : "table");
  const [efficiency, setEfficiency] = useState<"roas" | "cpa">("roas");
  const [openCreative, setOpenCreative] = useState<DataRow | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (next: string[]) => {
      setVisible(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void savePreference(`data.columns.${model.key}`, next), 600);
    },
    [model.key],
  );

  const visibility = useMemo(() => visibilityFrom(model, visible), [model, visible]);
  const flags = {
    colorCompare: sp.get("cvc") === "1",
    colorTarget: sp.get("cvt") === "1",
    showDelta: sp.get("delta") === "1",
    threshold: p.threshold,
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return model.rows;
    const match = (r: DataRow): DataRow | null => {
      const kids = r.children?.map(match).filter((x): x is DataRow => !!x) ?? [];
      if (r.label.toLowerCase().includes(q) || (r.sub ?? "").toLowerCase().includes(q)) return r;
      return kids.length ? { ...r, children: kids, records: kids.length } : null;
    };
    return model.rows.map(match).filter((x): x is DataRow => !!x);
  }, [model.rows, query]);

  const linkFor = (updates: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    return `/data?${q}`;
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv(model, rows, visible)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.clientSlug}_${model.key.replace(".", "-")}_${p.range.from}_${p.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const allColumns = model.columns;
  const groups = useMemo(() => {
    const g = new Map<string, typeof allColumns>();
    for (const c of allColumns) {
      const name = c.metric ? (METRIC_MAP[c.metric]?.group ?? "Other") : "Details";
      g.set(name, [...(g.get(name) ?? []), c]);
    }
    return [...g];
  }, [allColumns]);

  const showChart = model.chart && view === "table";

  return (
    <Card className="overflow-hidden">
      {/* platform tabs */}
      <nav className="scroll-thin flex items-center gap-1 overflow-x-auto px-4 pt-3" aria-label="Platforms">
        {PLATFORM_TABS.map((t) => (
          <Link
            key={t.id}
            href={linkFor({ platform: t.id, tab: null, campaign: null })}
            scroll={false}
            aria-current={p.platform === t.id ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] text-muted hover:text-foreground",
              p.platform === t.id && "bg-accent font-medium text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {/* sub-tabs */}
      <div className="mt-2 border-y border-border bg-surface-2 px-3 py-1.5">
        <nav className="scroll-thin flex items-center gap-0.5 overflow-x-auto" aria-label="Breakdowns">
          {SUB_TABS[p.platform].map((t) => (
            <Link
              key={t.id}
              href={linkFor({ tab: t.id === "core" ? null : t.id })}
              scroll={false}
              aria-current={p.tab === t.id ? "page" : undefined}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1 text-[12.5px] text-muted hover:text-foreground",
                p.tab === t.id && "bg-surface font-medium text-foreground shadow-[0_0_0_1px_var(--border)]",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[12.5px]">
          <Search className="size-3.5 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rows…"
            className="w-36 bg-transparent outline-none placeholder:text-subtle"
            aria-label="Search rows"
          />
        </label>
        {p.campaigns.length > 0 && (
          <select
            value={p.campaign ?? ""}
            onChange={(e) => set({ campaign: e.target.value || null })}
            aria-label="Filter by campaign"
            className="h-7 max-w-[240px] rounded-md border border-border bg-surface px-2 text-[12.5px]"
          >
            <option value="">All campaigns</option>
            {p.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {model.compareLabel && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <Switch
                checked={flags.colorCompare}
                onCheckedChange={(v) => set({ cvc: v ? "1" : null, cvt: null }, { replace: true })}
                data-testid="toggle-color-compare"
              />
              Color vs comparison
            </label>
          )}
          <label
            className={cn("flex items-center gap-1.5 text-[12px] text-muted", !model.hasTargets && "opacity-50")}
            title={model.hasTargets ? undefined : "No targets for these rows — set them on the Targets page."}
          >
            <Switch
              checked={flags.colorTarget}
              disabled={!model.hasTargets}
              onCheckedChange={(v) => set({ cvt: v ? "1" : null, cvc: null }, { replace: true })}
            />
            Color vs target
          </label>
          {model.compareLabel && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <Switch checked={flags.showDelta} onCheckedChange={(v) => set({ delta: v ? "1" : null }, { replace: true })} />
              Show Δ%
            </label>
          )}
          {model.chart && (
            <div className="flex h-7 items-center rounded-md border border-border p-0.5 text-[11px]">
              {(["roas", "cpa"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEfficiency(e)}
                  className={cn("rounded px-2 py-0.5 uppercase text-muted", efficiency === e && "bg-accent font-medium text-foreground")}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          {model.view === "creatives" && (
            <div className="flex h-7 items-center rounded-md border border-border p-0.5">
              <button
                type="button"
                aria-label="Grid view"
                onClick={() => setView("grid")}
                className={cn("rounded p-1 text-muted", view === "grid" && "bg-accent text-foreground")}
              >
                <LayoutGrid className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Table view"
                onClick={() => setView("table")}
                className={cn("rounded p-1 text-muted", view === "table" && "bg-accent text-foreground")}
              >
                <Rows3 className="size-3.5" />
              </button>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="columns-button">
                <Columns3 /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="scroll-thin max-h-[60vh] w-60 overflow-y-auto">
              {groups.map(([g, cols]) => (
                <div key={g}>
                  <DropdownMenuLabel>{g}</DropdownMenuLabel>
                  {cols.map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={visible.includes(c.id)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(on) =>
                        persist(
                          on
                            ? model.columns.filter((x) => x.id === c.id || visible.includes(x.id)).map((x) => x.id)
                            : visible.filter((v) => v !== c.id),
                        )
                      }
                    >
                      {c.metric ? `${METRIC_MAP[c.metric]?.label}${c.kind === "share" ? " (% of total)" : ""}` : headerLabel(c)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </div>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => persist(model.defaultVisible)}>Reset to default</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="export-csv">
            <Download /> CSV
          </Button>
        </div>
      </div>

      {model.notices?.map((n, i) => (
        <div
          key={i}
          role={n.tone === "warn" ? "alert" : "note"}
          className={cn(
            "flex items-start gap-2 border-b border-border px-4 py-2 text-[12.5px]",
            n.tone === "warn" ? "bg-warn-bg text-warn" : "bg-surface-2 text-muted",
          )}
        >
          {n.tone === "warn" ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
          <span>{n.text}</span>
        </div>
      ))}

      <div className={cn("transition-opacity", pending && "opacity-60")}>
        {showChart && model.chart?.kind === "segments" && (
          <SegmentCharts chart={model.chart} currency={model.currency} efficiency={efficiency} />
        )}
        {showChart && model.chart?.kind === "heatmap" && <Heatmap chart={model.chart} currency={model.currency} metric={efficiency} />}
        {model.view === "creatives" && view === "grid" ? (
          <CreativesGrid model={model} rows={rows} onOpen={setOpenCreative} />
        ) : (
          <DataTable
            model={model}
            rows={rows}
            visibility={visibility}
            onVisibilityChange={(v) =>
              persist(model.columns.filter((c) => v[c.id] !== false && (v[c.id] || visible.includes(c.id))).map((c) => c.id))
            }
            flags={flags}
          />
        )}
      </div>
      {model.view === "creatives" && (
        <CreativeDialog row={openCreative} model={model} clientId={p.clientId} range={p.range} onClose={() => setOpenCreative(null)} />
      )}
    </Card>
  );
}
