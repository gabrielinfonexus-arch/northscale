"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  columnVisibilityFeature,
  createExpandedRowModel,
  createSortedRowModel,
  rowExpandingFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type Row,
  type SortFn,
  type SortingState,
  type ExpandedState,
  type ColumnVisibilityState as VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import { getMetric, METRIC_MAP } from "@/lib/metrics";
import { EMPTY, formatMetricValue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import type { ColumnSpec, DataRow, DataTableModel } from "@/server/data/types";
import { cellTitle, cmp, Delta, metricValue, shareValue, toneBg, VerdictBadge, vsTarget } from "./cells";

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  columnVisibilityFeature,
});
type F = typeof features;

export interface TableFlags {
  colorCompare: boolean;
  colorTarget: boolean;
  showDelta: boolean;
  threshold: number;
}

const ROW_H = 37;

const nullsLast = (get: (r: DataRow) => number | string | null | undefined): SortFn<F, DataRow> => {
  return (a: Row<F, DataRow>, b: Row<F, DataRow>) => {
    const x = get(a.original),
      y = get(b.original);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return x < y ? -1 : 1;
  };
};

export function headerLabel(c: ColumnSpec): string {
  if (c.header) return c.header;
  if (c.metric) return METRIC_MAP[c.metric]?.short ?? c.metric;
  return c.id;
}

export function columnValue(c: ColumnSpec, row: DataRow, grand: DataTableModel["total"]): number | string | null {
  if (c.kind === "metric" && c.metric) return metricValue(c.metric, row.totals);
  if (c.kind === "share" && c.shareOf) return shareValue(c.shareOf, row.totals, grand);
  if (c.kind === "text") return row.text?.[c.id] ?? null;
  if (c.kind === "badge") return row.badge ? { winner: 3, watch: 2, cut: 1 }[row.badge] : null;
  return null;
}

function MetricHeader({ c }: { c: ColumnSpec }) {
  const def = c.metric ? METRIC_MAP[c.metric] : null;
  const label = headerLabel(c);
  if (!def) return <span>{label}</span>;
  const content =
    c.kind === "share" ? (
      <span>Share of the total {def.label.toLowerCase()} in this table.</span>
    ) : (
      <span>
        <b className="font-semibold">{def.label}</b> — {def.description}
        <br />
        <span className="opacity-80">Formula: {def.formula}</span>
      </span>
    );
  return (
    <Tooltip content={content}>
      <span className="cursor-help underline decoration-dotted decoration-transparent underline-offset-4 hover:decoration-current">
        {label}
      </span>
    </Tooltip>
  );
}

export function DataTable({
  model,
  rows,
  visibility,
  onVisibilityChange,
  flags,
}: {
  model: DataTableModel;
  rows: DataRow[];
  visibility: VisibilityState;
  onVisibilityChange: (v: VisibilityState) => void;
  flags: TableFlags;
}) {
  const [sorting, setSorting] = useState<SortingState>([model.defaultSort]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  useEffect(() => {
    setSorting([model.defaultSort]);
    setExpanded({});
  }, [model.key, model.defaultSort]);

  const columns = useMemo<ColumnDef<F, DataRow>[]>(() => {
    const first: ColumnDef<F, DataRow> = {
      id: "first",
      header: () => model.firstColumn,
      accessorFn: (r) => r.label,
      sortFn: nullsLast((r) => r.sortKey ?? r.label.toLowerCase()),
      enableHiding: false,
      cell: ({ row }) => {
        const r = row.original;
        const canExpand = row.getCanExpand();
        return (
          <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: row.depth * 18 }}>
            {canExpand ? (
              <button
                type="button"
                onClick={row.getToggleExpandedHandler()}
                aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
                aria-expanded={row.getIsExpanded()}
                className="-ml-1 rounded p-0.5 text-subtle hover:bg-accent hover:text-foreground"
              >
                <ChevronRight className={cn("size-3.5 transition-transform", row.getIsExpanded() && "rotate-90")} />
              </button>
            ) : row.depth === 0 && model.rows.some((x) => x.children?.length) ? (
              <span className="w-[18px]" />
            ) : null}
            <span
              className={cn("truncate", row.depth > 0 ? "text-[12.5px] text-zinc-600 dark:text-zinc-400" : "text-foreground")}
              title={r.label}
            >
              {r.label}
            </span>
            {r.records ? <span className="shrink-0 text-[10.5px] text-subtle">({r.records} records)</span> : null}
            {r.sub && row.depth === 0 && !r.records ? <span className="truncate text-[11px] text-subtle">{r.sub}</span> : null}
            {r.sub && row.depth > 0 ? <span className="truncate text-[11px] text-subtle">· {r.sub}</span> : null}
          </div>
        );
      },
    };
    const rest: ColumnDef<F, DataRow>[] = model.columns.map((c) => ({
      id: c.id,
      header: () => (c.kind === "metric" || c.kind === "share" ? <MetricHeader c={c} /> : headerLabel(c)),
      accessorFn: (r: DataRow) => columnValue(c, r, model.total),
      sortFn: nullsLast((r) => columnValue(c, r, model.total)),
      sortDescFirst: c.kind !== "text",
      enableSorting: c.kind !== "thumb",
      cell: () => null, // rendered manually below for speed
    }));
    return [first, ...rest];
  }, [model]);

  const table = useTable({
    features,
    columns,
    data: rows,
    getSubRows: (r: DataRow) => r.children,
    state: { sorting, expanded, columnVisibility: visibility },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onColumnVisibilityChange: (u) => onVisibilityChange(typeof u === "function" ? u(visibility) : u),
    enableSortingRemoval: false,
    autoResetExpanded: false,
  });

  const flat = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = flat.length > 120;
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    enabled: virtual,
  });
  const items = virtual ? virtualizer.getVirtualItems() : null;
  const padTop = items && items.length ? items[0].start : 0;
  const padBottom = items && items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;
  const visibleRows = items ? items.map((i) => flat[i.index]) : flat;

  const leafCols = table.getVisibleLeafColumns();
  const specById = useMemo(() => new Map(model.columns.map((c) => [c.id, c])), [model.columns]);

  const renderCell = (spec: ColumnSpec, r: DataRow, isTotal: boolean, extra: string) => {
    const cur = model.currency;
    if (spec.kind === "text") {
      const v = r.text?.[spec.id];
      return (
        <td key={spec.id} className={cn("whitespace-nowrap px-3 text-left text-[12.5px] text-zinc-600 dark:text-zinc-400", extra)}>
          {isTotal ? "" : (v ?? EMPTY)}
        </td>
      );
    }
    if (spec.kind === "thumb") {
      return (
        <td key={spec.id} className={cn("px-3", extra)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ad-platform CDN thumbnails */}
          {!isTotal && r.thumb ? <img src={r.thumb} alt="" className="size-8 rounded object-cover" loading="lazy" /> : null}
        </td>
      );
    }
    if (spec.kind === "badge")
      return (
        <td key={spec.id} className={cn("px-3", extra)}>
          {isTotal ? null : <VerdictBadge badge={r.badge} />}
        </td>
      );
    if (spec.kind === "share" && spec.shareOf) {
      const v = shareValue(spec.shareOf, r.totals, model.total);
      return (
        <td key={spec.id} className={cn("num whitespace-nowrap px-3 text-right", extra)}>
          {formatMetricValue(v, "percent", cur)}
        </td>
      );
    }
    const metric = spec.metric!;
    const def = getMetric(metric);
    const value = metricValue(metric, r.totals);
    const prev = isTotal ? model.totalCompare : r.compare;
    const c = prev !== undefined ? cmp(metric, r.totals, prev, flags.threshold) : null;
    const t = vsTarget(metric, r.totals, isTotal ? model.totalTarget : r.target, flags.threshold);
    const tone = flags.colorTarget && t ? t.tone : flags.colorCompare && c ? c.tone : "neutral";
    const showDelta = (flags.showDelta || isTotal) && c && prev && value !== null;
    return (
      <td
        key={spec.id}
        className={cn("num whitespace-nowrap px-3 text-right", extra, toneBg[tone])}
        title={cellTitle(metric, c, t, cur, value === null ? (model.unavailable[metric] ?? "Not provided by this source.") : undefined)}
      >
        <div className="flex flex-col items-end leading-tight">
          <span className={cn(value === null && "text-subtle")}>{formatMetricValue(value, def.format, cur)}</span>
          {showDelta ? <Delta c={c!} currency={cur} /> : null}
        </div>
      </td>
    );
  };

  const totalRow: DataRow = { id: "__total", label: "Total", totals: model.total };

  return (
    <div ref={scrollRef} className="scroll-thin relative max-h-[calc(100vh-260px)] min-h-[200px] overflow-auto" data-testid="data-table">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-20 bg-surface">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h, i) => {
                const sorted = h.column.getIsSorted();
                const spec = specById.get(h.column.id);
                const right = spec && spec.kind !== "text" && spec.kind !== "thumb" && spec.kind !== "badge";
                return (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                    className={cn(
                      "h-9 whitespace-nowrap border-b border-border bg-surface px-3 text-[10.5px] font-medium uppercase tracking-[0.04em] text-subtle",
                      right ? "text-right" : "text-left",
                      i === 0 && "sticky left-0 z-10 min-w-[220px] pl-12",
                    )}
                  >
                    <button
                      type="button"
                      onClick={h.column.getToggleSortingHandler()}
                      disabled={!h.column.getCanSort()}
                      className={cn("inline-flex items-center gap-1 uppercase hover:text-foreground", right && "flex-row-reverse")}
                    >
                      <table.FlexRender header={h} />
                      {sorted === "asc" ? (
                        <ChevronUp className="size-3" />
                      ) : sorted === "desc" ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <span className="size-3" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
          <tr className="font-medium" data-testid="totals-row">
            <td className="sticky left-0 z-10 h-[38px] border-b border-border bg-surface-2 pl-12 pr-3 text-[12px] uppercase tracking-wide text-muted">
              Total
              {model.compareLabel ? <span className="ml-1 normal-case tracking-normal text-subtle">· {model.compareLabel}</span> : null}
            </td>
            {leafCols.slice(1).map((col) => renderCell(specById.get(col.id)!, totalRow, true, "border-b border-border bg-surface-2"))}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr>
              <td style={{ height: padTop }} colSpan={leafCols.length} />
            </tr>
          )}
          {visibleRows.map((row) => {
            const r = row.original;
            return (
              <tr key={row.id} className={cn("group h-[37px] hover:bg-accent/60", row.depth > 0 && "bg-surface-2/60")}>
                <td className="sticky left-0 z-10 max-w-[360px] border-b border-border bg-surface px-3 pl-4 group-hover:bg-accent">
                  <table.FlexRender cell={row.getAllCells()[0]} />
                </td>
                {leafCols.slice(1).map((col) => renderCell(specById.get(col.id)!, r, false, "border-b border-border"))}
              </tr>
            );
          })}
          {padBottom > 0 && (
            <tr>
              <td style={{ height: padBottom }} colSpan={leafCols.length} />
            </tr>
          )}
        </tbody>
      </table>
      {flat.length === 0 && <div className="px-6 py-14 text-center text-[13px] text-muted">No rows for this selection.</div>}
    </div>
  );
}
