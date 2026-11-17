export interface NavItem {
  href: string;
  label: string;
  /** Build phase where the page is implemented (for placeholders). */
  phase: number;
  description: string;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      {
        href: "/watchdog",
        label: "Watchdog",
        phase: 6,
        description:
          "Automatic alerts per client and account: CPA/ROAS vs target, pacing, stopped spend, rejected ads, broken tracking, winners and ads to cut.",
      },
      {
        href: "/hive-mind",
        label: "Hive-Mind",
        phase: 7,
        description: "Chat with an AI that can read every metric, breakdown, target and note in NorthScale.",
      },
      {
        href: "/dashboard",
        label: "Dashboard",
        phase: 2,
        description: "KPI cards, trends with chart notes, spend by platform, revenue by channel, funnel and pacing.",
      },
      { href: "/data", label: "Data", phase: 1, description: "Dense data tables for every platform and breakdown." },
      {
        href: "/chart-notes",
        label: "Chart Notes",
        phase: 2,
        description: "Annotations shown on every time chart and available to the AI.",
      },
      { href: "/targets", label: "Targets", phase: 2, description: "Monthly targets, breakeven calculator and pacing." },
      { href: "/pnl", label: "P&L", phase: 5, description: "Daily / weekly / monthly profit & loss and contribution margin." },
      {
        href: "/ai-insights",
        label: "AI Insights",
        phase: 7,
        description: "Scheduled AI analysis: what changed, likely cause and recommended action.",
      },
    ],
  },
  {
    group: "Manage",
    items: [
      {
        href: "/clients",
        label: "Clients",
        phase: 8,
        description: "Create clients and connect their Meta, Google, Shopify and other revenue accounts.",
      },
      {
        href: "/sync-status",
        label: "Sync Status",
        phase: 3,
        description: "Status of every connection, last sync, errors and manual re-sync.",
      },
      { href: "/sync-overview", label: "Sync Overview", phase: 3, description: "Job history, rate-limit usage and backfills in progress." },
      { href: "/billing", label: "Billing", phase: 8, description: "Plan, usage and AI token consumption per client." },
    ],
  },
  {
    group: "Settings",
    items: [
      { href: "/team", label: "Team Members", phase: 8, description: "Invite teammates and assign roles and clients." },
      {
        href: "/client-viewers",
        label: "Client Viewers",
        phase: 8,
        description: "Read-only access for your clients, with per-page permissions and expiring links.",
      },
    ],
  },
  { group: "Help", items: [{ href: "/help", label: "Help", phase: 8, description: "Metric glossary, connection guides and FAQ." }] },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

/** Pages with phase <= CURRENT_PHASE are implemented; the rest render a placeholder. */
export const CURRENT_PHASE = 8;
