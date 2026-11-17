"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { RULE_MAP } from "@/lib/watchdog/rules";
import { accessibleClientIds, assertCanEdit, getCurrentUser } from "./auth";
import { runWatchdog } from "./watchdog/run";
import { isValidSlackWebhook, sendNotifications } from "./watchdog/notify";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const touched = (clientId: string) => {
  updateTag(`alerts:${clientId}`);
  updateTag("alerts");
};

async function alertFor(id: string) {
  const a = await prisma.alert.findUnique({ where: { id }, select: { id: true, clientId: true } });
  if (!a) throw new Error("Alert not found");
  await assertCanEdit(a.clientId);
  return a;
}

export async function resolveAlert(id: string): Promise<Result> {
  const a = await alertFor(id);
  await prisma.alert.update({ where: { id }, data: { status: "RESOLVED", resolvedAt: new Date(), autoResolved: false, mutedUntil: null } });
  touched(a.clientId);
  return { ok: true };
}

export async function muteAlert(id: string, days: number): Promise<Result> {
  if (![1, 3, 7, 14, 30].includes(days)) return { ok: false, error: "Invalid mute period." };
  const a = await alertFor(id);
  await prisma.alert.update({ where: { id }, data: { status: "MUTED", mutedUntil: new Date(Date.now() + days * 86_400_000) } });
  touched(a.clientId);
  return { ok: true };
}

export async function reopenAlert(id: string): Promise<Result> {
  const a = await alertFor(id);
  await prisma.alert.update({ where: { id }, data: { status: "OPEN", resolvedAt: null, mutedUntil: null, autoResolved: false } });
  touched(a.clientId);
  return { ok: true };
}

/** "Run checks now": one client, or every client the user can edit. */
export async function runChecksNow(clientId: string | null): Promise<Result<{ created: number; resolved: number; open: number }>> {
  const user = await getCurrentUser();
  if (user.role === "CLIENT_VIEWER") return { ok: false, error: "Forbidden" };
  const ids = clientId ? [(await assertCanEdit(clientId)) && clientId] : await accessibleClientIds(user);
  let created = 0,
    resolved = 0;
  for (const id of ids) {
    const r = await runWatchdog(id);
    created += r.created + r.reopened;
    resolved += r.resolved;
    updateTag(`alerts:${id}`);
  }
  updateTag("alerts");
  const open = await prisma.alert.count({ where: { clientId: { in: ids }, status: "OPEN" } });
  return { ok: true, created, resolved, open };
}

const RuleInput = z.object({
  enabled: z.boolean(),
  params: z.record(z.string(), z.number().finite()),
  notifyEmail: z.boolean(),
  notifySlack: z.boolean(),
});

export async function saveRule(clientId: string, ruleKey: string, input: z.infer<typeof RuleInput>): Promise<Result> {
  const rule = RULE_MAP[ruleKey];
  if (!rule) return { ok: false, error: "Unknown rule." };
  const parsed = RuleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid values." };
  await assertCanEdit(clientId);
  const params: Record<string, number> = {};
  for (const p of rule.params) {
    const v = parsed.data.params[p.key];
    if (v === undefined) continue;
    if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))
      return { ok: false, error: `${p.label} must be between ${p.min ?? "−∞"} and ${p.max ?? "∞"}.` };
    params[p.key] = v;
  }
  const data = { enabled: parsed.data.enabled, params, notifyEmail: parsed.data.notifyEmail, notifySlack: parsed.data.notifySlack };
  await prisma.alertRule.upsert({
    where: { clientId_ruleKey: { clientId, ruleKey } },
    update: data,
    create: { clientId, ruleKey, ...data },
  });
  touched(clientId);
  return { ok: true };
}

export async function resetRule(clientId: string, ruleKey: string): Promise<Result> {
  await assertCanEdit(clientId);
  await prisma.alertRule.deleteMany({ where: { clientId, ruleKey } });
  touched(clientId);
  return { ok: true };
}

const NotifInput = z.object({
  /** undefined = keep the stored webhook; "" = remove it */
  slackWebhook: z.string().trim().optional(),
  alertEmails: z.array(z.email()).max(20),
  minSeverity: z.enum(["CRITICAL", "WARNING", "INFO"]),
});

async function assertOrgAdmin() {
  const user = await getCurrentUser();
  if (user.role !== "OWNER" && user.role !== "ADMIN") throw new Error("Forbidden");
  return user;
}

export async function saveNotificationSettings(input: z.infer<typeof NotifInput>): Promise<Result> {
  const parsed = NotifInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the email addresses." };
  const user = await assertOrgAdmin();
  const { slackWebhook, alertEmails, minSeverity } = parsed.data;
  if (slackWebhook && !isValidSlackWebhook(slackWebhook))
    return { ok: false, error: "Use a Slack incoming webhook URL (https://hooks.slack.com/services/…)." };
  await prisma.orgSetting.update({
    where: { organizationId: user.organizationId },
    data: {
      alertEmails: [...new Set(alertEmails.map((e) => e.toLowerCase()))],
      alertMinSeverity: minSeverity,
      ...(slackWebhook === undefined ? {} : { slackWebhookEncrypted: slackWebhook ? encryptSecret(slackWebhook) : null }),
    },
  });
  return { ok: true };
}

export async function sendTestNotification(): Promise<Result<{ slack?: string | true; email?: string | true }>> {
  const user = await assertOrgAdmin();
  const s = await prisma.orgSetting.findUnique({ where: { organizationId: user.organizationId } });
  if (!s?.slackWebhookEncrypted && !s?.alertEmails.length) return { ok: false, error: "Add a Slack webhook or an email first." };
  const test = {
    severity: "INFO" as const,
    title: "Test notification",
    message: "Watchdog notifications are working. Alerts at or above your minimum severity will arrive here.",
    clientName: "NorthScale",
    url: null,
  };
  const r = await sendNotifications({ slack: [test], email: [test] }, s);
  return { ok: true, ...r };
}
