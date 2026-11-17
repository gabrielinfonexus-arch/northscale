import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { PageTitle } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { prisma } from "@/lib/db";
import { requirePage } from "@/server/auth";

export const metadata: Metadata = { title: "Billing" };

const usd = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: v < 1 ? 4 : 2,
  }).format(v);
const n = (v: number) => new Intl.NumberFormat("en-US").format(v);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums">{value}</div>
    </Card>
  );
}

async function Content() {
  const user = await requirePage("billing");
  await connection();
  const org = user.organizationId;
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - 5, 1);
  since.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [settings, clients, conns, staff, viewers, byMonth, byClient] = await Promise.all([
    prisma.orgSetting.findUnique({ where: { organizationId: org } }),
    prisma.client.count({ where: { organizationId: org, archivedAt: null } }),
    prisma.connection.groupBy({
      by: ["platform"],
      where: { client: { organizationId: org, archivedAt: null }, status: { not: "DISCONNECTED" }, isDemo: false },
      _count: true,
    }),
    prisma.membership.count({ where: { organizationId: org, role: { not: "CLIENT_VIEWER" } } }),
    prisma.membership.count({ where: { organizationId: org, role: "CLIENT_VIEWER" } }),
    prisma.$queryRawUnsafe<{ month: string; feature: string; input: number; output: number; cost: number }[]>(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month, feature, SUM("inputTokens" + "cacheReadTokens" + "cacheWriteTokens")::float8 AS input,
              SUM("outputTokens")::float8 AS output, SUM("costUsd")::float8 AS cost
       FROM ai_usage WHERE ("organizationId" = $1 OR "organizationId" IS NULL) AND "createdAt" >= $2 GROUP BY 1, 2 ORDER BY 1 DESC`,
      org,
      since,
    ),
    prisma.$queryRawUnsafe<{ client: string | null; feature: string; calls: number; cost: number }[]>(
      `SELECT c.name AS client, u.feature, COUNT(*)::int AS calls, SUM(u."costUsd")::float8 AS cost
       FROM ai_usage u LEFT JOIN clients c ON c.id = u."clientId"
       WHERE (u."organizationId" = $1 OR u."organizationId" IS NULL) AND u."createdAt" >= $2 GROUP BY 1, 2 ORDER BY 4 DESC`,
      org,
      monthStart,
    ),
  ]);
  const months = [...new Set(byMonth.map((r) => r.month))];
  const monthCost = byMonth.filter((r) => r.month === monthStart.toISOString().slice(0, 7)).reduce((s, r) => s + r.cost, 0);
  const connCount = conns.reduce((s, c) => s + c._count, 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Plan" value={settings?.plan === "internal" ? "Internal" : (settings?.plan ?? "—")} />
        <Stat label="Active clients" value={n(clients)} />
        <Stat label="Connected accounts" value={n(connCount)} />
        <Stat label="Team · viewers" value={`${staff} · ${viewers}`} />
        <Stat label="AI cost this month" value={usd(monthCost)} />
      </div>

      <section>
        <h2 className="mb-2 text-[14px] font-medium">AI usage by month (Anthropic API)</h2>
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-[13px] tabular-nums" data-testid="ai-usage-months">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-subtle">
              <tr>
                <th className="px-4 py-2 font-medium">Month</th>
                <th className="px-4 py-2 text-right font-medium">Hive-Mind</th>
                <th className="px-4 py-2 text-right font-medium">AI Insights</th>
                <th className="px-4 py-2 text-right font-medium">Input tokens</th>
                <th className="px-4 py-2 text-right font-medium">Output tokens</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const rows = byMonth.filter((r) => r.month === m);
                const f = (k: string) => rows.filter((r) => r.feature === k).reduce((s, r) => s + r.cost, 0);
                return (
                  <tr key={m} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">{m}</td>
                    <td className="px-4 py-2 text-right">{usd(f("hive_mind"))}</td>
                    <td className="px-4 py-2 text-right">{usd(f("insights"))}</td>
                    <td className="px-4 py-2 text-right">{n(rows.reduce((s, r) => s + r.input, 0))}</td>
                    <td className="px-4 py-2 text-right">{n(rows.reduce((s, r) => s + r.output, 0))}</td>
                    <td className="px-4 py-2 text-right font-medium">{usd(rows.reduce((s, r) => s + r.cost, 0))}</td>
                  </tr>
                );
              })}
              {!months.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-3 text-muted">
                    No AI usage yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-[14px] font-medium">This month by client</h2>
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-[13px] tabular-nums">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-subtle">
              <tr>
                <th className="px-4 py-2 font-medium">Client</th>
                <th className="px-4 py-2 font-medium">Feature</th>
                <th className="px-4 py-2 text-right font-medium">Calls</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byClient.map((r, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">{r.client ?? "Several clients (Hive-Mind, all-clients scope)"}</td>
                  <td className="px-4 py-2">{r.feature === "hive_mind" ? "Hive-Mind" : "AI Insights"}</td>
                  <td className="px-4 py-2 text-right">{n(r.calls)}</td>
                  <td className="px-4 py-2 text-right">{usd(r.cost)}</td>
                </tr>
              ))}
              {!byClient.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-muted">
                    No AI usage this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>
      <p className="text-[12px] text-subtle">
        Costs are estimated from Anthropic list prices per token (incl. prompt-cache reads and writes) and stored per call in{" "}
        <code>ai_usage</code>. Selling access later: the plan field and these counts are where a Stripe subscription would plug in.
      </p>
    </div>
  );
}

export default function BillingPage() {
  return (
    <>
      <PageTitle title="Billing" />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <Content />
      </Suspense>
    </>
  );
}
