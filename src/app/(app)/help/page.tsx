import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { METRICS } from "@/lib/metrics";
import { requirePage } from "@/server/auth";

export const metadata: Metadata = { title: "Help" };

const GROUPS = ["Delivery", "Conversions", "Efficiency", "Funnel", "Commerce", "Blended", "Video"] as const;
const DIR = { up: "Higher is better", down: "Lower is better", neutral: "Neither better nor worse" } as const;

const GUIDES: { title: string; steps: string[] }[] = [
  {
    title: "Meta Ads",
    steps: [
      "Sync Status → Connect Meta. Use “Continue with Facebook” (OAuth) or paste a System User token from Business Settings → System users (ads_read, business_management).",
      "Pick the ad accounts and the client they belong to. The first sync backfills 13 months; then hourly (today) and daily (last 7 days, Meta adjusts conversions late).",
      "Audience Types needs Audience segments set up in Meta Ads Manager (Advertising settings → Audience segments); otherwise the tab explains how.",
    ],
  },
  {
    title: "Google Ads",
    steps: [
      "Needs a developer token (Basic access) and an OAuth client — see the README for the step-by-step.",
      "Sync Status → Connect Google → sign in → choose the accounts (MCC supported: the manager account is used as login-customer-id).",
      "Conversions are split by action (purchase, add to cart, begin checkout, lead) when the account has those actions.",
    ],
  },
  {
    title: "Shopify",
    steps: [
      "Sync Status → Connect Shopify: an Admin API access token (shpat_…), a Dev Dashboard app's client ID + secret, or “Install via OAuth”.",
      "Orders, refunds (on the refund date), new vs returning, discount codes, product costs (COGS) and the customer journey for UTM attribution are synced; webhooks keep it near real time.",
      "Products without a cost use the client's default margin — override costs per product on P&L → Costs.",
    ],
  },
  {
    title: "Other revenue",
    steps: [
      "Enter daily totals by hand, upload a CSV (date, source, revenue, orders), or POST to the webhook with the client's API key (Other Revenue page).",
    ],
  },
  {
    title: "A new client",
    steps: [
      "Clients → New client: name, currency, timezone and economics.",
      "Then connect its accounts, set this month's targets, and (optionally) invite the client as a viewer or create a public link.",
    ],
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Can NorthScale change my campaigns?",
    a: "No. Every integration is read-only: nothing is paused, edited or created in ad accounts or stores — not by the Watchdog, not by the AI.",
  },
  {
    q: "Why does platform revenue differ from Shopify revenue?",
    a: "Platforms count conversions with their own attribution windows and overlap (one order can be claimed by Meta and Google). Shopify is what was actually sold. The “attribution discrepancy” metric tracks the gap.",
  },
  {
    q: "What do the colours mean?",
    a: "Green = better, red = worse than the comparison period (or target), grey = within ±2% or a metric with no better/worse direction (e.g. spend).",
  },
  {
    q: "Why do I see “—”?",
    a: "The platform doesn't provide that number for those rows (e.g. reach on Google, video metrics without video ads). Hover the cell to see why. NorthScale never fills in estimates.",
  },
  {
    q: "Which currency are totals in?",
    a: "The client's reporting currency. Accounts in other currencies are converted with the daily exchange rate of each day.",
  },
  { q: "Today's numbers look low.", a: "Today is incomplete and platforms report with a delay. Presets like “Last 7 days” end yesterday." },
  {
    q: "Who sees what?",
    a: "Owners and Admins see every client; Analysts only their assigned clients; Client Viewers only their own client and the pages chosen for them. The AI follows the same rules.",
  },
  {
    q: "How much does the AI cost?",
    a: "Billing shows the Anthropic API cost per month and per client. Roughly US$0.05 per client per insights run and a few cents per Hive-Mind question.",
  },
];

async function Content() {
  await requirePage("help");
  return (
    <div className="flex flex-col gap-8">
      <nav className="flex flex-wrap gap-2 text-[13px]" aria-label="Help sections">
        {[
          ["#glossary", "Metric glossary"],
          ["#connect", "Connecting accounts"],
          ["#faq", "FAQ"],
        ].map(([h, l]) => (
          <a key={h} href={h} className="rounded-md border border-border px-2.5 py-1 hover:bg-accent">
            {l}
          </a>
        ))}
      </nav>

      <section id="glossary">
        <h2 className="mb-1 text-[16px] font-semibold">Metric glossary</h2>
        <p className="mb-3 text-[13px] text-muted">The same definitions every screen and the AI use (src/lib/metrics.ts).</p>
        <div className="flex flex-col gap-4">
          {GROUPS.map((g) => {
            const items = METRICS.filter((m) => m.group === g);
            if (!items.length) return null;
            return (
              <Card key={g} className="p-0">
                <h3 className="border-b border-border px-4 py-2 text-[12px] font-medium uppercase tracking-wide text-subtle">{g}</h3>
                <dl className="divide-y divide-border" data-testid={`glossary-${g}`}>
                  {items.map((m) => (
                    <div key={m.key} id={`metric-${m.key}`} className="grid gap-1 px-4 py-2.5 text-[13px] md:grid-cols-[200px_1fr]">
                      <dt className="font-medium">{m.label}</dt>
                      <dd>
                        <span className="font-mono text-[12px] text-muted">{m.formula}</span>
                        <span className="block text-muted">
                          {m.description} <span className="text-subtle">· {DIR[m.direction]}</span>
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>
            );
          })}
        </div>
      </section>

      <section id="connect">
        <h2 className="mb-3 text-[16px] font-semibold">Connecting accounts</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {GUIDES.map((g) => (
            <Card key={g.title} className="p-4">
              <h3 className="mb-2 text-[14px] font-medium">{g.title}</h3>
              <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted">
                {g.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-muted">
          Problems with a connection?{" "}
          <Link href="/sync-status" className="text-primary underline">
            Sync Status
          </Link>{" "}
          shows the last error and lets you re-sync or reconnect.
        </p>
      </section>

      <section id="faq">
        <h2 className="mb-3 text-[16px] font-semibold">FAQ</h2>
        <Card className="divide-y divide-border p-0">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-4 py-3">
              <summary className="cursor-pointer text-[13.5px] font-medium">{f.q}</summary>
              <p className="mt-1.5 text-[13px] text-muted">{f.a}</p>
            </details>
          ))}
        </Card>
      </section>
    </div>
  );
}

export default function HelpPage() {
  return (
    <>
      <PageTitle title="Help" />
      <Suspense>
        <Content />
      </Suspense>
    </>
  );
}
