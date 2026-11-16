"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Calculator, Copy, Save, Wand2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { breakeven } from "@/lib/breakeven";
import { getMetric } from "@/lib/metrics";
import { formatMetricValue, EMPTY } from "@/lib/format";
import { saveBreakevenSettings, saveTargets } from "@/server/target-actions";
import type { MonthTargets, TargetField, TargetScope } from "@/server/targets";
import { cn } from "@/lib/utils";

type Fields = Record<TargetScope, { field: TargetField; metric: string; label: string }[]>;
type Form = Record<TargetScope, Partial<Record<TargetField, string>>>;

const SCOPE_LABEL: Record<TargetScope, string> = { CLIENT: "Whole client (blended)", META: "Meta", GOOGLE: "Google" };
const input =
  "num h-8 w-full rounded-md border border-border bg-surface px-2 text-right text-[13px] outline-none focus:ring-2 focus:ring-ring";

function toForm(t: MonthTargets | null, fields: Fields): Form {
  const f: Form = { CLIENT: {}, META: {}, GOOGLE: {} };
  if (!t) return f;
  for (const scope of ["CLIENT", "META", "GOOGLE"] as const)
    for (const { field } of fields[scope]) {
      const v = t[scope][field];
      f[scope][field] = typeof v === "number" ? String(Math.round(v * 100) / 100) : "";
    }
  return f;
}

export interface Economics {
  aov: number;
  marginPct: number | null;
  monthlySpend: number;
}

export function TargetsWorkspace({
  clientId,
  month,
  currency,
  fields,
  targets,
  previous,
  economics,
  saved,
  canEdit,
}: {
  clientId: string;
  month: string;
  currency: string;
  fields: Fields;
  targets: MonthTargets;
  previous: MonthTargets | null;
  economics: Economics | null;
  saved: { aov: number | null; marginPct: number | null; fixedCosts: number; multiplier: number };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Form>(() => toForm(targets, fields));
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // breakeven inputs
  const [aov, setAov] = useState(String(saved.aov ?? (economics ? Math.round(economics.aov * 100) / 100 : "")));
  const [margin, setMargin] = useState(String(saved.marginPct ?? (economics?.marginPct ? Math.round(economics.marginPct * 10) / 10 : "")));
  const [fixed, setFixed] = useState(String(saved.fixedCosts ?? 0));
  const [mult, setMult] = useState(String(saved.multiplier ?? 1.1));
  const plannedSpend = Number(form.CLIENT.spend || economics?.monthlySpend || 0);
  const be = useMemo(
    () =>
      breakeven({
        aov: Number(aov) || 0,
        marginPct: Number(margin) || 0,
        fixedCosts: Number(fixed) || 0,
        plannedSpend,
        multiplier: Number(mult) || 1,
      }),
    [aov, margin, fixed, plannedSpend, mult],
  );

  const set = (scope: TargetScope, field: TargetField, v: string) => setForm((f) => ({ ...f, [scope]: { ...f[scope], [field]: v } }));
  const parse = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v.replace(",", ".")));

  const save = () =>
    start(async () => {
      setStatus(null);
      const values = (scope: TargetScope) => Object.fromEntries(fields[scope].map(({ field }) => [field, parse(form[scope][field])]));
      try {
        await saveTargets({ clientId, month, CLIENT: values("CLIENT"), META: values("META"), GOOGLE: values("GOOGLE") });
        setStatus("Targets saved.");
        router.refresh();
      } catch {
        setStatus("Could not save — check that every value is a positive number.");
      }
    });

  const saveInputs = () =>
    start(async () => {
      await saveBreakevenSettings({
        clientId,
        aov: Number(aov) || null,
        marginPct: margin === "" ? null : Number(margin),
        fixedCosts: Number(fixed) || 0,
        multiplier: Math.max(1, Number(mult) || 1.1),
      });
      setStatus("Breakeven inputs saved.");
      router.refresh();
    });

  const applyBreakeven = () => {
    const r2 = (x: number | null) => (x === null ? "" : String(Math.round(x * 100) / 100));
    setForm((f) => ({
      CLIENT: { ...f.CLIENT, mer: r2(be.targetRoas) },
      META: { ...f.META, roas: r2(be.targetRoas), cpa: r2(be.targetCpa) },
      GOOGLE: { ...f.GOOGLE, roas: r2(be.targetRoas), cpa: r2(be.targetCpa) },
    }));
    setStatus("Breakeven targets applied — review and save.");
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
      <Card className="p-4" data-testid="targets-editor">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">Monthly targets</h2>
          <span className="text-xs text-muted">
            Additive targets (spend, revenue, orders, customers) are prorated per day in tables and pacing.
          </span>
          {canEdit && previous && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setForm(toForm(previous, fields))}>
              <Copy /> Copy previous month
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {(["CLIENT", "META", "GOOGLE"] as const).map((scope) => (
            <fieldset key={scope} disabled={!canEdit}>
              <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{SCOPE_LABEL[scope]}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {fields[scope].map(({ field, metric, label }) => {
                  const def = getMetric(metric);
                  return (
                    <label key={field} className="flex flex-col gap-1 text-[11.5px] text-muted">
                      <Tooltip content={`${def.label}: ${def.formula}`}>
                        <span className="cursor-help">
                          {label}
                          {def.format === "currency" ? ` (${currency})` : def.format === "ratio" ? " (x)" : ""}
                        </span>
                      </Tooltip>
                      <input
                        inputMode="decimal"
                        className={input}
                        value={form[scope][field] ?? ""}
                        onChange={(e) => set(scope, field, e.target.value)}
                        placeholder={EMPTY}
                        aria-label={`${SCOPE_LABEL[scope]} ${label}`}
                      />
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          {canEdit && (
            <Button onClick={save} disabled={pending} data-testid="save-targets">
              <Save /> {pending ? "Saving…" : "Save targets"}
            </Button>
          )}
          {status && (
            <span role="status" className="text-xs text-muted">
              {status}
            </span>
          )}
        </div>
      </Card>

      <Card className="p-4" data-testid="breakeven">
        <div className="mb-3 flex items-center gap-2">
          <Calculator className="size-4 text-muted" />
          <h2 className="text-[13px] font-semibold">Breakeven calculator</h2>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["AOV", aov, setAov, currency],
              ["Gross margin %", margin, setMargin, "%"],
              ["Fixed costs / month", fixed, setFixed, currency],
              ["Profit multiplier", mult, setMult, "x"],
            ] as const
          ).map(([label, val, setter, unit]) => (
            <label key={label} className="flex flex-col gap-1 text-[11.5px] text-muted">
              {label} ({unit})
              <input
                inputMode="decimal"
                className={input}
                value={val}
                onChange={(e) => setter(e.target.value)}
                aria-label={label}
                disabled={!canEdit}
              />
            </label>
          ))}
        </div>
        {economics && canEdit && (
          <button
            type="button"
            className="mt-2 text-xs text-muted underline hover:text-foreground"
            onClick={() => {
              setAov(String(Math.round(economics.aov * 100) / 100));
              if (economics.marginPct !== null) setMargin(String(Math.round(economics.marginPct * 10) / 10));
            }}
          >
            Pull AOV and margin from Shopify (last 90 days)
          </button>
        )}
        <p className="mt-2 text-[11px] text-subtle">
          Margin = after COGS and payment fees. Planned spend uses the client spend target (
          {formatMetricValue(plannedSpend || null, "currency", currency)}).
        </p>
        <dl className="num mt-3 grid grid-cols-2 gap-2">
          {(
            [
              ["Breakeven ROAS / MER", be.breakevenRoas, "ratio"],
              ["Breakeven CPA", be.breakevenCpa, "currency"],
              ["Target ROAS / MER", be.targetRoas, "ratio"],
              ["Target CPA", be.targetCpa, "currency"],
              ["Contribution / order", be.contributionPerOrder || null, "currency"],
              ["Breakeven revenue", be.breakevenRevenue, "currency"],
            ] as const
          ).map(([label, v, fmt], i) => (
            <div key={label} className={cn("rounded-lg px-3 py-2", i === 2 || i === 3 ? "bg-good-bg" : "bg-accent")}>
              <dt className="text-[10.5px] uppercase tracking-wide text-muted">{label}</dt>
              <dd className="text-[15px] font-semibold">{formatMetricValue(v, fmt, currency)}</dd>
            </div>
          ))}
        </dl>
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={applyBreakeven} disabled={be.targetRoas === null} data-testid="apply-breakeven">
              <Wand2 /> Apply to targets
            </Button>
            <Button size="sm" variant="outline" onClick={saveInputs} disabled={pending}>
              Save inputs
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
