import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import { RULES, defaultParams } from "@/lib/watchdog/rules";
import { accessibleClientIds, getCurrentUser } from "../auth";
import { decryptSecret, redact } from "@/lib/crypto";

export type AlertStatusFilter = "open" | "muted" | "resolved" | "all";
export type SeverityFilter = "all" | "CRITICAL" | "WARNING" | "INFO";

export interface AlertRow {
  id: string;
  clientId: string;
  clientName: string;
  clientSlug: string;
  connectionName: string | null;
  platform: string | null;
  ruleKey: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  status: "OPEN" | "RESOLVED" | "MUTED";
  title: string;
  message: string;
  dataLink: string | null;
  createdAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  autoResolved: boolean;
  mutedUntil: string | null;
  notifiedAt: string | null;
}

const STATUS = { open: ["OPEN"], muted: ["MUTED"], resolved: ["RESOLVED"], all: ["OPEN", "MUTED", "RESOLVED"] } as const;

/** Alerts for the given clients (already permission-checked by the caller via accessibleClientIds). */
async function loadAlerts(clientIds: string[], status: AlertStatusFilter, severity: SeverityFilter) {
  "use cache";
  cacheLife("minutes");
  cacheTag("alerts", ...clientIds.map((id) => `alerts:${id}`));
  const where = { clientId: { in: clientIds }, status: { in: [...STATUS[status]] } };
  const [rows, counts] = await Promise.all([
    prisma.alert.findMany({
      where: { ...where, ...(severity !== "all" ? { severity } : {}) },
      orderBy: status === "resolved" ? [{ resolvedAt: "desc" }] : [{ severity: "asc" }, { lastSeenAt: "desc" }],
      take: 500,
      include: { client: { select: { name: true, slug: true } } },
    }),
    prisma.alert.groupBy({ by: ["severity"], where, _count: true }),
  ]);
  const connIds = [...new Set(rows.map((r) => r.connectionId).filter((x): x is string => !!x))];
  const conns = new Map(
    (await prisma.connection.findMany({ where: { id: { in: connIds } }, select: { id: true, name: true, platform: true } })).map((c) => [
      c.id,
      c,
    ]),
  );
  const list: AlertRow[] = rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.client.name,
    clientSlug: r.client.slug,
    connectionName: r.connectionId ? (conns.get(r.connectionId)?.name ?? null) : null,
    platform: r.connectionId ? (conns.get(r.connectionId)?.platform ?? null) : null,
    ruleKey: r.ruleKey,
    severity: r.severity,
    status: r.status,
    title: r.title,
    message: r.message,
    dataLink: r.dataLink,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    autoResolved: r.autoResolved,
    mutedUntil: r.mutedUntil?.toISOString() ?? null,
    notifiedAt: r.notifiedAt?.toISOString() ?? null,
  }));
  const bySev = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const c of counts) bySev[c.severity] = c._count;
  return { rows: list, counts: bySev };
}

export async function listAlerts(opts: { clientId: string | null; status: AlertStatusFilter; severity: SeverityFilter }) {
  const user = await getCurrentUser();
  const allowed = await accessibleClientIds(user);
  const ids = opts.clientId ? allowed.filter((id) => id === opts.clientId) : allowed;
  return loadAlerts(ids, opts.status, opts.severity);
}

async function loadOpenCritical(clientIds: string[]) {
  "use cache";
  cacheLife("minutes");
  cacheTag("alerts", ...clientIds.map((id) => `alerts:${id}`));
  return prisma.alert.count({ where: { clientId: { in: clientIds }, status: "OPEN", severity: "CRITICAL" } });
}

/** Sidebar badge: open critical alerts across every client the user can see. */
export async function openCriticalCount() {
  const user = await getCurrentUser();
  return loadOpenCritical(await accessibleClientIds(user));
}

/** Rule settings for a client: every rule with stored overrides merged over defaults. */
export async function getRuleSettings(clientId: string) {
  const stored = new Map((await prisma.alertRule.findMany({ where: { clientId } })).map((r) => [r.ruleKey, r]));
  return RULES.map((r) => {
    const s = stored.get(r.key);
    return {
      key: r.key,
      label: r.label,
      description: r.description,
      params: r.params,
      enabled: s?.enabled ?? true,
      values: { ...defaultParams(r), ...((s?.params as Record<string, number>) ?? {}) },
      notifyEmail: s?.notifyEmail ?? true,
      notifySlack: s?.notifySlack ?? true,
      customized: !!s,
    };
  });
}

/** Notification settings, safe for the browser: the Slack webhook is shown redacted only. */
export async function getNotificationSettings() {
  const user = await getCurrentUser();
  const s = await prisma.orgSetting.findUnique({ where: { organizationId: user.organizationId } });
  let slackHint: string | null = null;
  if (s?.slackWebhookEncrypted) {
    try {
      slackHint = redact(decryptSecret(s.slackWebhookEncrypted));
    } catch {
      slackHint = "(stored, cannot be decrypted — save it again)";
    }
  }
  return {
    slackConfigured: !!s?.slackWebhookEncrypted,
    slackHint,
    alertEmails: s?.alertEmails ?? [],
    minSeverity: (s?.alertMinSeverity ?? "WARNING") as "CRITICAL" | "WARNING" | "INFO",
    resendConfigured: !!process.env.RESEND_API_KEY,
    canEdit: user.role === "OWNER" || user.role === "ADMIN",
  };
}
