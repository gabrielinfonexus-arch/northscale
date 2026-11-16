"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Trash2, Upload } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMetricValue } from "@/lib/format";
import { formatDay } from "@/lib/periods";
import { parseOtherRevenueCsv, type ParseResult } from "@/lib/other-revenue-csv";
import { deleteOtherRevenue, rotateWebhookKey, saveOtherRevenue } from "@/server/other-revenue-actions";

interface Entry {
  id: string;
  date: string;
  source: string;
  revenue: number;
  orders: number;
  currency: string;
}

const field = "h-8 rounded-md border border-border bg-surface px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring";

export function OtherRevenueManager({
  clientId,
  currency,
  today,
  range,
  entries,
  sources,
  hasKey,
  endpoint,
}: {
  clientId: string;
  currency: string;
  today: string;
  range: { from: string; to: string };
  entries: Entry[];
  sources: string[];
  hasKey: boolean;
  endpoint: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  // daily totals are usually entered for a completed day
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  const [form, setForm] = useState({ date: yesterday, source: sources[0] ?? "", revenue: "", orders: "" });
  const [csv, setCsv] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [key, setKey] = useState<string | null>(null);

  const total = useMemo(() => entries.reduce((s, e) => s + (e.currency === currency ? e.revenue : 0), 0), [entries, currency]);

  const add = () =>
    start(async () => {
      const revenue = Number(form.revenue.replace(",", "."));
      const r = await saveOtherRevenue(clientId, [
        { date: form.date, source: form.source.trim(), revenue, orders: Math.max(0, Math.round(Number(form.orders || 0))) },
      ]);
      const outside = form.date < range.from || form.date > range.to;
      setMsg(
        r.ok
          ? `Saved ${form.source} on ${formatDay(form.date)}.${outside ? " (Outside the period shown below — change the date range to see it.)" : ""}`
          : r.error,
      );
      if (r.ok) {
        setForm({ ...form, revenue: "", orders: "" });
        router.refresh();
      }
    });

  const importCsv = () =>
    start(async () => {
      if (!csv?.rows.length) return;
      const r = await saveOtherRevenue(clientId, csv.rows);
      setMsg(r.ok ? `Imported ${r.saved} rows from ${fileName}.` : r.error);
      if (r.ok) {
        setCsv(null);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-4">
      {msg && (
        <div role="status" className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">
          {msg}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <h2 className="mb-3 text-[13px] font-semibold">Add a day</h2>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted">
              Date
              <input
                type="date"
                required
                max={today}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Source
              <input
                required
                list="or-sources"
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
                className={field}
                placeholder="Amazon, Mercado Livre, Stripe…"
              />
              <datalist id="or-sources">
                {sources.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted">
                Revenue ({currency})
                <input
                  required
                  inputMode="decimal"
                  value={form.revenue}
                  onChange={(e) => setForm({ ...form, revenue: e.target.value })}
                  className={`${field} num text-right`}
                  aria-label="Revenue"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Orders
                <input
                  inputMode="numeric"
                  value={form.orders}
                  onChange={(e) => setForm({ ...form, orders: e.target.value })}
                  className={`${field} num text-right`}
                  aria-label="Orders"
                />
              </label>
            </div>
            <Button type="submit" disabled={pending} data-testid="or-save">
              Save
            </Button>
            <p className="text-[11px] text-subtle">Saving the same date + source again replaces it.</p>
          </form>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-[13px] font-semibold">Import CSV</h2>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong px-3 py-5 text-center text-xs text-muted hover:bg-accent">
            <Upload className="size-4" />
            {fileName || "Choose a .csv file"}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="CSV file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileName(f.name);
                setCsv(parseOtherRevenueCsv(await f.text()));
              }}
            />
          </label>
          <p className="mt-2 text-[11px] text-subtle">
            Columns: date, source, revenue, orders (optional), currency (optional). Portuguese headers, “;” and 1.234,56 work too.
          </p>
          {csv && (
            <div className="mt-3 flex flex-col gap-2 text-[12px]" data-testid="csv-preview">
              <div>
                <b>{csv.rows.length}</b> valid rows{csv.errors.length ? `, ${csv.errors.length} with errors` : ""}
              </div>
              {csv.errors.slice(0, 4).map((e) => (
                <div key={e.line} className="text-bad">
                  Line {e.line}: {e.message}
                </div>
              ))}
              <Button size="sm" onClick={importCsv} disabled={pending || !csv.rows.length} data-testid="csv-import">
                Import {csv.rows.length} rows
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
            <KeyRound className="size-3.5" /> Webhook
          </h2>
          <p className="text-[12px] text-muted">Let Stripe, Amazon, TikTok Shop, Hotmart (or Zapier / Make) push daily totals.</p>
          <code className="mt-2 block break-all rounded bg-accent px-2 py-1 text-[11px]">POST {endpoint}</code>
          {key ? (
            <div className="mt-2 flex flex-col gap-1 text-[11.5px]" data-testid="webhook-key">
              <span className="text-warn">Copy this key now — it won&apos;t be shown again.</span>
              <code className="block break-all rounded bg-accent px-2 py-1">{key}</code>
              <code className="block whitespace-pre-wrap break-all rounded bg-accent px-2 py-1 text-[10.5px]">{`curl -X POST ${endpoint} \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "content-type: application/json" \\\n  -d '{"date":"${today}","source":"Hotmart","revenue":1234.5,"orders":7}'`}</code>
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-subtle">{hasKey ? "A key exists. Generating a new one revokes it." : "No key yet."}</p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await rotateWebhookKey(clientId);
                if (r.ok) setKey(r.key);
              })
            }
            data-testid="rotate-key"
          >
            {hasKey ? "Regenerate key" : "Generate key"}
          </Button>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-baseline justify-between px-4 pb-2 pt-3">
          <h2 className="text-[13px] font-semibold">Entries in the selected period</h2>
          <span className="num text-[12px] text-muted">Total {formatMetricValue(total, "currency", currency)}</span>
        </div>
        <table className="num w-full text-[13px]" data-testid="or-entries">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
              <th className="border-b border-border px-4 py-2 text-left font-medium">Date</th>
              <th className="border-b border-border px-4 py-2 text-left font-medium">Source</th>
              <th className="border-b border-border px-4 py-2 text-right font-medium">Revenue</th>
              <th className="border-b border-border px-4 py-2 text-right font-medium">Orders</th>
              <th className="border-b border-border px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-accent/50">
                <td className="border-b border-border px-4 py-1.5">{formatDay(e.date)}</td>
                <td className="border-b border-border px-4 py-1.5">{e.source}</td>
                <td className="border-b border-border px-4 py-1.5 text-right">{formatMetricValue(e.revenue, "currency", e.currency)}</td>
                <td className="border-b border-border px-4 py-1.5 text-right">{e.orders}</td>
                <td className="border-b border-border px-4 py-1.5 text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${e.source} ${e.date}`}
                    onClick={() =>
                      start(async () => {
                        await deleteOtherRevenue(e.id);
                        router.refresh();
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted">
                  No entries in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
