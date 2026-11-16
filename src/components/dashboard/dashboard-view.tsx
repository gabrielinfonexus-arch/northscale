"use client";
import "react-grid-layout/css/styles.css";
import { useMemo, useRef, useState } from "react";
import ReactGridLayout, { useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import { GripVertical, LayoutDashboard, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NoteDialog, type NoteDraft } from "@/components/notes/note-dialog";
import { getMetric } from "@/lib/metrics";
import { savePreference } from "@/server/actions";
import type { DashboardModel } from "@/server/data/dashboard";
import { cn } from "@/lib/utils";
import { DEFAULT_KPIS, KPI_OPTIONS, KpiCards } from "./kpi-cards";
import { TrendChart } from "./trend-chart";
import {
  Funnel,
  PacingCard,
  PlatformVsShopify,
  RevenueByChannel,
  SpendByPlatform,
  TopCampaigns,
  TopCreatives,
  TopProducts,
} from "./widgets";

export interface DashboardPrefs {
  layout?: { i: string; x: number; y: number; w: number; h: number }[];
  kpis?: string[];
}

const WIDGETS: {
  i: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  chromeless?: boolean;
}[] = [
  { i: "kpis", title: "Key metrics", x: 0, y: 0, w: 12, h: 6, minH: 3, chromeless: true },
  { i: "trend", title: "Trend", x: 0, y: 6, w: 8, h: 10, minW: 4, minH: 7 },
  { i: "pacing", title: "This month vs targets", x: 8, y: 6, w: 4, h: 10, minW: 3, minH: 6 },
  { i: "spend-platform", title: "Spend by platform", x: 0, y: 16, w: 6, h: 8, minW: 3, minH: 5 },
  { i: "revenue-channel", title: "Revenue by channel", x: 6, y: 16, w: 6, h: 8, minW: 4, minH: 5 },
  { i: "platform-vs-shopify", title: "Platform-reported vs Shopify revenue", x: 0, y: 24, w: 6, h: 8, minW: 4, minH: 6 },
  { i: "funnel", title: "Funnel", x: 6, y: 24, w: 6, h: 8, minW: 4, minH: 6 },
  { i: "top-campaigns", title: "Top campaigns", x: 0, y: 32, w: 4, h: 7, minW: 3, minH: 6 },
  { i: "top-creatives", title: "Top creatives", x: 4, y: 32, w: 4, h: 7, minW: 3, minH: 6 },
  { i: "top-products", title: "Top products", x: 8, y: 32, w: 4, h: 7, minW: 3, minH: 6 },
];
const DEFAULT_LAYOUT = WIDGETS.map(({ i, x, y, w, h, minW, minH }) => ({ i, x, y, w, h, minW, minH }));

function mergeLayout(saved: DashboardPrefs["layout"]): LayoutItem[] {
  if (!saved?.length) return DEFAULT_LAYOUT;
  const byId = new Map(saved.map((l) => [l.i, l]));
  return DEFAULT_LAYOUT.map((d) => {
    const s = byId.get(d.i);
    return s ? { ...d, x: s.x, y: s.y, w: s.w, h: s.h } : { ...d, y: 1000 };
  });
}

export function DashboardView({
  model,
  prefs,
  clientId,
  threshold,
  hasCompare,
  links,
  today,
}: {
  model: DashboardModel;
  prefs: DashboardPrefs | null;
  clientId: string;
  threshold: number;
  hasCompare: boolean;
  links: { campaigns: string; creatives: string; products: string; targets: string };
  today: string;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<LayoutItem[]>(() => mergeLayout(prefs?.layout));
  const [kpis, setKpis] = useState<string[]>(() =>
    prefs?.kpis?.length ? prefs.kpis.filter((k) => (KPI_OPTIONS as readonly string[]).includes(k)) : DEFAULT_KPIS,
  );
  const [note, setNote] = useState<NoteDraft | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = (next: DashboardPrefs) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void savePreference("dashboard", next), 500);
  };
  const updateLayout = (l: Layout) => {
    const next = l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    setLayout((prev) => prev.map((p) => ({ ...p, ...(next.find((n) => n.i === p.i) ?? {}) })));
    if (editing) persist({ layout: next, kpis });
  };
  const updateKpis = (next: string[]) => {
    setKpis(next);
    persist({ layout: layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })), kpis: next });
  };
  const reset = () => {
    setLayout(DEFAULT_LAYOUT);
    setKpis(DEFAULT_KPIS);
    persist({});
  };

  const widget = (i: string) => {
    switch (i) {
      case "kpis":
        return (
          <KpiCards
            kpis={kpis}
            total={model.total}
            totalCompare={model.totalCompare}
            daily={model.daily}
            currency={model.currency}
            threshold={threshold}
            editing={editing}
            onReorder={updateKpis}
          />
        );
      case "trend":
        return (
          <TrendChart
            series={model.series}
            gran={model.gran}
            currency={model.currency}
            notes={model.notes}
            hasCompare={hasCompare}
            onAddNote={(date) => setNote({ date: date > today ? today : date })}
            onEditNote={(n) => setNote({ ...n })}
          />
        );
      case "pacing":
        return <PacingCard m={model} targetsHref={links.targets} />;
      case "spend-platform":
        return <SpendByPlatform m={model} />;
      case "revenue-channel":
        return <RevenueByChannel m={model} />;
      case "platform-vs-shopify":
        return <PlatformVsShopify m={model} threshold={threshold} />;
      case "funnel":
        return <Funnel m={model} threshold={threshold} />;
      case "top-campaigns":
        return <TopCampaigns m={model} dataHref={links.campaigns} />;
      case "top-creatives":
        return <TopCreatives m={model} dataHref={links.creatives} />;
      case "top-products":
        return <TopProducts m={model} dataHref={links.products} />;
    }
    return null;
  };

  const frame = (w: (typeof WIDGETS)[number], body: React.ReactNode) =>
    w.chromeless ? (
      <div className="relative h-full">
        {editing && <GripVertical className="drag-handle absolute -left-1 -top-1 z-10 size-4 cursor-move rounded bg-surface text-muted" />}
        {body}
      </div>
    ) : (
      <Card className="flex h-full flex-col overflow-hidden" data-testid={`widget-${w.i}`}>
        <div className={cn("flex items-center gap-2 px-4 pb-1 pt-3", editing && "drag-handle cursor-move")}>
          {editing && <GripVertical className="size-3.5 text-subtle" />}
          <h2 className="text-[13px] font-semibold">{w.title}</h2>
        </div>
        <div className="min-h-0 flex-1 px-4 pb-3 pt-1">{body}</div>
      </Card>
    );

  const isWide = width >= 1024;
  const ordered = useMemo(
    () =>
      [...WIDGETS].sort((a, b) => {
        const la = layout.find((l) => l.i === a.i)!,
          lb = layout.find((l) => l.i === b.i)!;
        return la.y - lb.y || la.x - lb.x;
      }),
    [layout],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <SlidersHorizontal /> KPIs
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="scroll-thin max-h-[60vh] overflow-y-auto">
            <DropdownMenuLabel>Cards shown</DropdownMenuLabel>
            {KPI_OPTIONS.map((k) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={kpis.includes(k)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => updateKpis(on ? [...kpis, k] : kpis.filter((x) => x !== k))}
              >
                {getMetric(k).label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {editing && (
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw /> Reset layout
          </Button>
        )}
        <Button
          variant={editing ? "default" : "outline"}
          size="sm"
          onClick={() => setEditing(!editing)}
          data-testid="edit-layout"
          disabled={!isWide}
        >
          <LayoutDashboard /> {editing ? "Done" : "Edit layout"}
        </Button>
      </div>
      <div ref={containerRef} className="-mx-2.5">
        {mounted && isWide ? (
          <ReactGridLayout
            width={width}
            layout={layout}
            gridConfig={{ cols: 12, rowHeight: 34, margin: [12, 12], containerPadding: [10, 0] }}
            dragConfig={{ enabled: editing, handle: ".drag-handle" }}
            resizeConfig={{ enabled: editing }}
            onLayoutChange={updateLayout}
          >
            {WIDGETS.map((w) => (
              <div key={w.i}>{frame(w, widget(w.i))}</div>
            ))}
          </ReactGridLayout>
        ) : (
          <div className="flex flex-col gap-3 px-2.5">
            {ordered.map((w) => (
              <div key={w.i} style={{ height: w.i === "kpis" ? "auto" : w.i === "trend" ? 380 : 300 }}>
                {frame(w, widget(w.i))}
              </div>
            ))}
          </div>
        )}
      </div>
      <NoteDialog clientId={clientId} draft={note} onClose={() => setNote(null)} maxDate={today} />
    </>
  );
}
