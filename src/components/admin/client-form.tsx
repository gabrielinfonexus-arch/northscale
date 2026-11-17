"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createClient, updateClient, type ClientInput } from "@/server/client-actions";
import { field } from "./link-box";

const CURRENCIES = ["USD", "BRL", "EUR", "GBP", "CAD", "AUD", "MXN", "ARS", "CLP", "COP"];

export type ClientFormValues = { id?: string } & ClientInput;

export const NEW_CLIENT: ClientFormValues = {
  name: "",
  slug: "",
  currency: "USD",
  timezone: "America/New_York",
  logoUrl: "",
  defaultMarginPct: 60,
  paymentFeePct: 2.9,
  shippingCostPerOrder: 0,
  shippingCostPct: 0,
  fixedCostsMonthly: 0,
  newAudienceMinPct: 60,
};

const NUMBERS: { key: keyof ClientInput; label: string; unit: string; help: string }[] = [
  { key: "defaultMarginPct", label: "Default gross margin", unit: "%", help: "Used for products without a cost in Shopify (COGS)." },
  { key: "paymentFeePct", label: "Payment fees", unit: "%", help: "When Shopify doesn't report the transaction fee." },
  {
    key: "shippingCostPerOrder",
    label: "Shipping cost per order",
    unit: "currency",
    help: "What you pay to ship, not what the customer pays.",
  },
  { key: "shippingCostPct", label: "Shipping cost", unit: "% of net sales", help: "Alternative or in addition to per order." },
  {
    key: "fixedCostsMonthly",
    label: "Fixed costs per month",
    unit: "currency",
    help: "For the breakeven calculator; itemize on P&L → Costs.",
  },
  { key: "newAudienceMinPct", label: "Warn when new-audience spend is below", unit: "%", help: "Meta Audience Types tab." },
];

export function ClientForm({ initial, mode }: { initial: ClientFormValues; mode: "create" | "edit" }) {
  const router = useRouter();
  const [v, setV] = useState<ClientFormValues>(initial);
  const [nums, setNums] = useState(() => Object.fromEntries(NUMBERS.map((n) => [n.key, String(initial[n.key])])) as Record<string, string>);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const zones = useMemo(
    () => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [initial.timezone]),
    [initial.timezone],
  );
  const set = (k: keyof ClientFormValues, val: string) => {
    setSaved(false);
    setV({ ...v, [k]: val });
  };

  const submit = () =>
    start(async () => {
      const parsed = Object.fromEntries(NUMBERS.map((n) => [n.key, Number(String(nums[n.key]).replace(",", "."))]));
      if (Object.values(parsed).some((x) => !Number.isFinite(x))) return setError("Enter numbers only in the cost fields.");
      const input = { ...v, ...parsed } as ClientInput;
      const r = mode === "create" ? await createClient(input) : await updateClient(initial.id!, input);
      if (!r.ok) return setError(r.error);
      setError(null);
      if (mode === "create") router.push(`/clients/${r.slug}?onboarding=1`);
      else {
        setSaved(true);
        if (r.slug !== initial.slug) router.replace(`/clients/${r.slug}`);
        else router.refresh();
      }
    });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Card className="grid gap-4 p-5 md:grid-cols-2">
        <h2 className="text-[14px] font-medium md:col-span-2">Brand</h2>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Name</span>
          <input className={field} value={v.name} onChange={(e) => set("name", e.target.value)} required aria-label="Client name" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">URL slug</span>
          <input
            className={field}
            value={v.slug ?? ""}
            onChange={(e) => set("slug", e.target.value)}
            placeholder="generated from the name"
            aria-label="Slug"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Reporting currency</span>
          <input
            className={field}
            list="currencies"
            value={v.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
            maxLength={3}
            aria-label="Currency"
          />
          <datalist id="currencies">
            {CURRENCIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <span className="text-[12px] text-subtle">Every account is converted to it with daily FX rates.</span>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Reporting timezone</span>
          <select className={field} value={v.timezone} onChange={(e) => set("timezone", e.target.value)} aria-label="Timezone">
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] md:col-span-2">
          <span className="font-medium">Logo URL (optional)</span>
          <input
            className={field}
            value={v.logoUrl ?? ""}
            onChange={(e) => set("logoUrl", e.target.value)}
            placeholder="https://…"
            aria-label="Logo URL"
          />
        </label>
      </Card>
      <Card className="grid gap-4 p-5 md:grid-cols-2">
        <h2 className="text-[14px] font-medium md:col-span-2">Economics</h2>
        {NUMBERS.map((n) => (
          <label key={n.key} className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">
              {n.label} <span className="font-normal text-subtle">({n.unit === "currency" ? v.currency : n.unit})</span>
            </span>
            <input
              className={`${field} w-40 text-right tabular-nums`}
              inputMode="decimal"
              value={nums[n.key]}
              onChange={(e) => setNums({ ...nums, [n.key]: e.target.value })}
              aria-label={n.label}
            />
            <span className="text-[12px] text-subtle">{n.help}</span>
          </label>
        ))}
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {mode === "create" ? "Create client" : "Save changes"}
        </Button>
        {error && (
          <span role="alert" className="text-[13px] text-bad">
            {error}
          </span>
        )}
        {saved && (
          <span role="status" className="text-[13px] text-muted">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}
