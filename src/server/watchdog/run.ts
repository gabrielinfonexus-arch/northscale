import "server-only";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { evaluateRules, RULE_MAP, type Candidate, type LinkSpec } from "@/lib/watchdog/rules";
import { buildSnapshot } from "./snapshot";
import { appUrl, sendNotifications, severityAtLeast, type NotifyAlert } from "./notify";

const SEV_RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;

export function dataLink(slug: string, link?: LinkSpec): string | null {
  if (!link) return null;
  const p = new URLSearchParams({ client: slug });
  if (link.platform) p.set("platform", link.platform);
  if (link.tab) p.set("tab", link.tab);
  if (link.preset) p.set("preset", link.preset);
  if (link.accounts) p.set("accounts", link.accounts);
  return `/data?${p.toString()}`;
}

/** Per-client rule config: stored AlertRule rows merged over defaults. */
export async function ruleConfig(clientId: string) {
  const rows = await prisma.alertRule.findMany({ where: { clientId } });
  return Object.fromEntries(
    rows
      .filter((r) => RULE_MAP[r.ruleKey])
      .map((r) => [
        r.ruleKey,
        { enabled: r.enabled, params: (r.params as Record<string, number>) ?? {}, notifyEmail: r.notifyEmail, notifySlack: r.notifySlack },
      ]),
  );
}

export type Existing = {
  id: string;
  fingerprint: string;
  status: "OPEN" | "RESOLVED" | "MUTED";
  severity: keyof typeof SEV_RANK;
  mutedUntil: Date | null;
  autoResolved: boolean;
};

export type Plan =
  | { kind: "create"; c: Candidate; notify: true }
  | { kind: "update"; id: string; c: Candidate; reopen: boolean; notify: boolean }
  | { kind: "touch"; id: string; c: Candidate }
  | { kind: "resolve"; id: string };

/**
 * Alert lifecycle (pure, unit-tested):
 *  - new condition → OPEN + notify
 *  - still OPEN → refresh numbers; notify again only if it escalated to a higher severity
 *  - MUTED → silent until mutedUntil, then reopens if the condition persists
 *  - resolved by the system (condition had cleared) → reopens when it comes back
 *  - resolved by a person while the condition persists → stays resolved (acknowledged) unless it gets worse;
 *    once the condition clears it is marked auto-resolved so a later recurrence reopens it
 *  - OPEN/MUTED whose condition cleared → RESOLVED (autoResolved)
 */
export function planAlerts(candidates: Candidate[], existing: Existing[], now: Date): Plan[] {
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
  const seen = new Set<string>();
  const plans: Plan[] = [];
  for (const c of candidates) {
    if (seen.has(c.fingerprint)) continue;
    seen.add(c.fingerprint);
    const e = byFp.get(c.fingerprint);
    const worse = e ? SEV_RANK[c.severity] > SEV_RANK[e.severity] : false;
    if (!e) plans.push({ kind: "create", c, notify: true });
    else if (e.status === "OPEN") plans.push({ kind: "update", id: e.id, c, reopen: false, notify: worse });
    else if (e.status === "MUTED") {
      if (e.mutedUntil && e.mutedUntil > now) plans.push({ kind: "touch", id: e.id, c });
      else plans.push({ kind: "update", id: e.id, c, reopen: true, notify: true });
    } else if (e.autoResolved || worse) plans.push({ kind: "update", id: e.id, c, reopen: true, notify: true });
    else plans.push({ kind: "touch", id: e.id, c });
  }
  for (const e of existing)
    if (!seen.has(e.fingerprint) && (e.status !== "RESOLVED" || !e.autoResolved)) plans.push({ kind: "resolve", id: e.id });
  return plans;
}

export interface WatchdogResult {
  clientId: string;
  candidates: number;
  created: number;
  reopened: number;
  resolved: number;
  notified: { slack?: string | true; email?: string | true };
}

/** Evaluate every enabled rule for a client, persist alerts and notify. Read-only towards ad platforms. */
export async function runWatchdog(clientId: string, opts: { notify?: boolean } = {}): Promise<WatchdogResult> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    include: { organization: { include: { settings: true } } },
  });
  const config = await ruleConfig(clientId);
  const windowDays = Math.max(
    config.ad_to_cut?.params.windowDays ?? RULE_MAP.ad_to_cut.params.find((p) => p.key === "windowDays")!.default,
    config.ad_winner?.params.windowDays ?? RULE_MAP.ad_winner.params.find((p) => p.key === "windowDays")!.default,
  );
  const snapshot = await buildSnapshot(client, windowDays);
  const candidates = evaluateRules(snapshot, config);
  const existing = (await prisma.alert.findMany({
    where: { clientId },
    select: { id: true, fingerprint: true, status: true, severity: true, mutedUntil: true, autoResolved: true },
  })) as Existing[];
  const now = new Date();
  const plans = planAlerts(candidates, existing, now);

  const toNotify: { c: Candidate; id: string }[] = [];
  const fields = (c: Candidate) => ({
    severity: c.severity,
    title: c.title,
    message: c.message,
    ruleKey: c.ruleKey,
    connectionId: c.connectionId ?? null,
    entityId: c.entityId ?? null,
    dataLink: dataLink(client.slug, c.link),
    data: (c.data ?? undefined) as never,
    lastSeenAt: now,
  });
  let created = 0,
    reopened = 0,
    resolved = 0;
  for (const p of plans) {
    if (p.kind === "create") {
      const a = await prisma.alert.create({ data: { clientId, fingerprint: p.c.fingerprint, ...fields(p.c) } });
      created++;
      toNotify.push({ c: p.c, id: a.id });
    } else if (p.kind === "update") {
      await prisma.alert.update({
        where: { id: p.id },
        data: {
          ...fields(p.c),
          ...(p.reopen ? { status: "OPEN", resolvedAt: null, mutedUntil: null, autoResolved: false, createdAt: now } : {}),
        },
      });
      if (p.reopen) reopened++;
      if (p.notify) toNotify.push({ c: p.c, id: p.id });
    } else if (p.kind === "touch") {
      // condition persists but is muted/acknowledged: keep numbers fresh, no status change
      await prisma.alert.update({
        where: { id: p.id },
        data: { lastSeenAt: now, message: p.c.message, data: (p.c.data ?? undefined) as never },
      });
    } else {
      const r = await prisma.alert.updateMany({
        where: { id: p.id, status: { not: "RESOLVED" } },
        data: { status: "RESOLVED", resolvedAt: now, autoResolved: true },
      });
      if (r.count) resolved++;
      else await prisma.alert.update({ where: { id: p.id }, data: { autoResolved: true } }); // acknowledged one whose condition cleared
    }
  }

  let notified: WatchdogResult["notified"] = {};
  const s = client.organization.settings;
  if (opts.notify !== false && toNotify.length && s && (s.slackWebhookEncrypted || s.alertEmails.length)) {
    const eligible = toNotify.filter((n) => severityAtLeast(n.c.severity, s.alertMinSeverity));
    const asAlert = (c: Candidate): NotifyAlert => ({
      severity: c.severity,
      title: c.title,
      message: c.message,
      clientName: client.name,
      url: appUrl(dataLink(client.slug, c.link)),
    });
    const slack = eligible.filter((n) => config[n.c.ruleKey]?.notifySlack ?? true);
    const email = eligible.filter((n) => config[n.c.ruleKey]?.notifyEmail ?? true);
    if (slack.length || email.length) {
      notified = await sendNotifications({ slack: slack.map((n) => asAlert(n.c)), email: email.map((n) => asAlert(n.c)) }, s);
      const sent = new Set([...(notified.slack === true ? slack : []), ...(notified.email === true ? email : [])].map((n) => n.id));
      if (sent.size) await prisma.alert.updateMany({ where: { id: { in: [...sent] } }, data: { notifiedAt: now } });
      for (const [ch, r] of Object.entries(notified)) if (r !== true) console.warn(`[watchdog] ${ch} notification failed: ${r}`);
    }
  }

  try {
    revalidateTag(`alerts:${clientId}`, "max");
    revalidateTag(`client:${clientId}`, "max");
  } catch {
    // outside a Next.js runtime (scripts): nothing to revalidate
  }
  return { clientId, candidates: candidates.length, created, reopened, resolved, notified };
}

/** Never let the Watchdog break a sync. */
export async function runWatchdogSafe(clientId: string) {
  try {
    return await runWatchdog(clientId);
  } catch (e) {
    console.warn(`[watchdog] client ${clientId} failed: ${(e as Error).message}`);
    return null;
  }
}

/** Every active client (daily cron). */
export async function runWatchdogAll() {
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true } });
  const out = [];
  for (const c of clients) out.push(await runWatchdogSafe(c.id));
  return out;
}
