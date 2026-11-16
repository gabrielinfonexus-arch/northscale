"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMetricValue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deleteCostItem, saveCostItem, saveCostSettings, saveProductCosts } from "@/server/cost-actions";

const input =
  "num h-8 w-full rounded-md border border-border bg-surface px-2 text-right text-[13px] outline-none focus:ring-2 focus:ring-ring";
const TYPE_LABEL = { FIXED_MONTHLY: "Fixed / month", VARIABLE_PER_ORDER: "Per order", VARIABLE_PCT_REVENUE: "% of net sales" } as const;
type CostTypeKey = keyof typeof TYPE_LABEL;

export interface CostItemRow {
  id: string;
  name: string;
  type: string;
  amount: number;
  startDate: string;
  endDate: string;
}
export interface ProductCostRow {
  productId: string;
  title: string;
  units: number;
  revenue: number;
  shopifyCost: number | null;
  override: number | null;
  avgPrice: number;
}

export function CostSettings({
  clientId,
  currency,
  settings,
  items,
  products,
}: {
  clientId: string;
  currency: string;
  settings: { shippingCostPerOrder: number; shippingCostPct: number; paymentFeePct: number; defaultMarginPct: number };
  items: CostItemRow[];
  products: ProductCostRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [s, setS] = useState(
    Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(Math.round(v * 10000) / 10000)])) as Record<
      keyof typeof settings,
      string
    >,
  );
  const [draft, setDraft] = useState({ name: "", type: "FIXED_MONTHLY" as CostTypeKey, amount: "", startDate: "", endDate: "" });
  const [overrides, setOverrides] = useState<Record<string, string>>(
    Object.fromEntries(products.map((p) => [p.productId, p.override === null ? "" : String(p.override)])),
  );
  const num = (x: string) => Number(x.replace(",", "."));
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? ok : (r as { error: string }).error);
      if (r.ok) router.refresh();
    });

  const changedProducts = products.filter((p) => (overrides[p.productId] ?? "") !== (p.override === null ? "" : String(p.override)));

  return (
    <div className="flex flex-col gap-4">
      {msg && (
        <div role="status" className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">
          {msg}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4" data-testid="cost-settings">
          <h2 className="mb-3 text-[13px] font-semibold">Fulfilment, fees and margin</h2>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["shippingCostPerOrder", `Shipping cost per order (${currency})`],
                ["shippingCostPct", "Shipping cost (% of net sales)"],
                ["paymentFeePct", "Payment fees % (when Shopify has no fee data)"],
                ["defaultMarginPct", "Default gross margin % (products without cost)"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1 text-[11.5px] text-muted">
                {label}
                <input
                  inputMode="decimal"
                  className={input}
                  value={s[k]}
                  onChange={(e) => setS({ ...s, [k]: e.target.value })}
                  aria-label={label}
                />
              </label>
            ))}
          </div>
          <Button
            className="mt-3"
            size="sm"
            disabled={pending}
            data-testid="save-cost-settings"
            onClick={() =>
              run(
                () =>
                  saveCostSettings(clientId, {
                    shippingCostPerOrder: num(s.shippingCostPerOrder),
                    shippingCostPct: num(s.shippingCostPct),
                    paymentFeePct: num(s.paymentFeePct),
                    defaultMarginPct: num(s.defaultMarginPct),
                  }),
                "Cost settings saved.",
              )
            }
          >
            Save
          </Button>
        </Card>

        <Card className="p-4" data-testid="cost-items">
          <h2 className="mb-3 text-[13px] font-semibold">Other costs</h2>
          <table className="num mb-3 w-full text-[12.5px]">
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-border">
                  <td className="py-1.5">{i.name}</td>
                  <td className="py-1.5 text-muted">{TYPE_LABEL[i.type as CostTypeKey]}</td>
                  <td className="py-1.5 text-right">
                    {i.type === "VARIABLE_PCT_REVENUE" ? `${i.amount}%` : formatMetricValue(i.amount, "currency", currency)}
                  </td>
                  <td className="py-1.5 text-right text-[11px] text-subtle">
                    {i.startDate || i.endDate ? `${i.startDate || "…"} → ${i.endDate || "…"}` : ""}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${i.name}`}
                      onClick={() => run(() => deleteCostItem(clientId, i.id), `Removed ${i.name}.`)}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td className="py-3 text-muted">No other costs yet — add rent, salaries, apps, packaging, agency fees…</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <input
              className={cn(input, "text-left sm:col-span-2")}
              placeholder="Name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              aria-label="Cost name"
            />
            <select
              className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as CostTypeKey })}
              aria-label="Cost type"
            >
              {Object.entries(TYPE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <input
              className={input}
              placeholder={draft.type === "VARIABLE_PCT_REVENUE" ? "%" : currency}
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              aria-label="Cost amount"
            />
            <Button
              size="sm"
              disabled={pending || !draft.name || !draft.amount}
              data-testid="add-cost-item"
              onClick={() =>
                run(async () => {
                  const r = await saveCostItem(clientId, {
                    name: draft.name,
                    type: draft.type,
                    amount: num(draft.amount),
                    startDate: draft.startDate,
                    endDate: draft.endDate,
                  });
                  if (r.ok) setDraft({ ...draft, name: "", amount: "" });
                  return r;
                }, `Added ${draft.name}.`)
              }
            >
              <Plus /> Add
            </Button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-muted">
            <label className="flex flex-col gap-1">
              Starts (optional)
              <input
                type="date"
                className={input}
                value={draft.startDate}
                onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              Ends (optional)
              <input
                type="date"
                className={input}
                value={draft.endDate}
                onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
              />
            </label>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden" data-testid="product-costs">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
          <div>
            <h2 className="text-[13px] font-semibold">COGS per product</h2>
            <p className="text-[11.5px] text-muted">
              Shopify keeps only the current unit cost. An override applies to every order of the product (past and future) and recalculates
              the P&amp;L, Dashboard and Data.
            </p>
          </div>
          <Button
            size="sm"
            disabled={pending || changedProducts.length === 0}
            data-testid="save-product-costs"
            onClick={() =>
              run(
                () =>
                  saveProductCosts(
                    clientId,
                    changedProducts.map((p) => ({
                      productId: p.productId,
                      title: p.title,
                      unitCost: overrides[p.productId] === "" ? null : num(overrides[p.productId]),
                    })),
                  ),
                `Saved ${changedProducts.length} product cost${changedProducts.length > 1 ? "s" : ""}.`,
              )
            }
          >
            Save {changedProducts.length || ""} change{changedProducts.length === 1 ? "" : "s"}
          </Button>
        </div>
        <div className="scroll-thin max-h-[480px] overflow-auto">
          <table className="num w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
                {["Product", "Units (12m)", "Sales (12m)", "Avg price", "Shopify cost", "Override", "Margin"].map((h, i) => (
                  <th key={h} className={`border-b border-border px-4 py-2 font-medium ${i === 0 ? "text-left" : "text-right"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const o = overrides[p.productId] ?? "";
                const cost = o !== "" ? num(o) : p.shopifyCost;
                const margin = cost !== null && p.avgPrice ? 1 - cost / p.avgPrice : null;
                return (
                  <tr key={p.productId} className="hover:bg-accent/50">
                    <td className="border-b border-border px-4 py-1.5">{p.title}</td>
                    <td className="border-b border-border px-4 py-1.5 text-right">{p.units.toLocaleString()}</td>
                    <td className="border-b border-border px-4 py-1.5 text-right">
                      {formatMetricValue(p.revenue, "currency", currency, { compact: true })}
                    </td>
                    <td className="border-b border-border px-4 py-1.5 text-right">{formatMetricValue(p.avgPrice, "currency", currency)}</td>
                    <td className="border-b border-border px-4 py-1.5 text-right">
                      {p.shopifyCost === null ? (
                        <span className="text-warn">missing</span>
                      ) : (
                        formatMetricValue(p.shopifyCost, "currency", currency)
                      )}
                    </td>
                    <td className="w-32 border-b border-border px-4 py-1">
                      <input
                        inputMode="decimal"
                        className={input}
                        placeholder="—"
                        value={o}
                        onChange={(e) => setOverrides({ ...overrides, [p.productId]: e.target.value })}
                        aria-label={`Unit cost override for ${p.title}`}
                      />
                    </td>
                    <td className="border-b border-border px-4 py-1.5 text-right text-muted">
                      {margin === null ? "default" : formatMetricValue(margin, "percent", currency)}
                    </td>
                  </tr>
                );
              })}
              {products.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted">
                    No Shopify products sold in the last 12 months.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
