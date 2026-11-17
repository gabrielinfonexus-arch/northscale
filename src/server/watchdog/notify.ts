import "server-only";
import { decryptSecret } from "@/lib/crypto";

/** What a notifier needs about one alert. */
export interface NotifyAlert {
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  message: string;
  clientName: string;
  url: string | null;
}

const SEV_RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;
export const severityAtLeast = (s: keyof typeof SEV_RANK, min: string) => SEV_RANK[s] >= (SEV_RANK[min as keyof typeof SEV_RANK] ?? 1);

const ICON = { CRITICAL: ":red_circle:", WARNING: ":large_orange_circle:", INFO: ":large_blue_circle:" } as const;

/** Absolute app URL for links in notifications (relative links still work in-app). */
export function appUrl(path: string | null): string | null {
  if (!path) return null;
  const base = process.env.APP_URL?.replace(/\/$/, "");
  return base ? base + path : null;
}

export function slackPayload(alerts: NotifyAlert[]) {
  const header = alerts.length === 1 ? `NorthScale Watchdog: ${alerts[0].clientName}` : `NorthScale Watchdog: ${alerts.length} new alerts`;
  return {
    text: header,
    blocks: [
      { type: "header", text: { type: "plain_text", text: header.slice(0, 150) } },
      ...alerts.slice(0, 20).map((a) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${ICON[a.severity]} *${a.severity}* · ${a.clientName}\n*${a.title}*\n${a.message}${a.url ? `\n<${a.url}|View data>` : ""}`.slice(
            0,
            3000,
          ),
        },
      })),
      ...(alerts.length > 20
        ? [{ type: "context", elements: [{ type: "mrkdwn", text: `…and ${alerts.length - 20} more in NorthScale.` }] }]
        : []),
    ],
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function emailContent(alerts: NotifyAlert[]) {
  const subject =
    alerts.length === 1
      ? `[${alerts[0].severity}] ${alerts[0].clientName}: ${alerts[0].title}`
      : `NorthScale Watchdog: ${alerts.length} new alerts`;
  const color = { CRITICAL: "#dc2626", WARNING: "#d97706", INFO: "#2563eb" };
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">
<h2 style="font-size:16px">NorthScale Watchdog</h2>
${alerts
  .map(
    (a) => `<div style="border-left:3px solid ${color[a.severity]};padding:4px 10px;margin:10px 0">
<div style="font-size:12px;color:${color[a.severity]};font-weight:600">${a.severity} · ${esc(a.clientName)}</div>
<div style="font-weight:600">${esc(a.title)}</div><div>${esc(a.message)}</div>
${a.url ? `<a href="${esc(a.url)}">View data</a>` : ""}</div>`,
  )
  .join("\n")}
<p style="font-size:12px;color:#666">Read-only monitoring: NorthScale never changes your ad accounts.</p></div>`;
  const text = alerts.map((a) => `[${a.severity}] ${a.clientName}: ${a.title}\n${a.message}${a.url ? `\n${a.url}` : ""}`).join("\n\n");
  return { subject: subject.slice(0, 200), html, text };
}

export interface Channels {
  slackWebhookEncrypted: string | null;
  alertEmails: string[];
}

export function isValidSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

/** Send to Slack (incoming webhook) and/or email (Resend). Never throws; returns per-channel errors. Secrets are never logged. */
export async function sendNotifications(
  alerts: { slack: NotifyAlert[]; email: NotifyAlert[] },
  ch: Channels,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slack?: string | true; email?: string | true }> {
  const out: { slack?: string | true; email?: string | true } = {};
  if (alerts.slack.length && ch.slackWebhookEncrypted) {
    try {
      const url = decryptSecret(ch.slackWebhookEncrypted);
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(slackPayload(alerts.slack)),
      });
      out.slack = r.ok ? true : `Slack responded ${r.status}`;
    } catch (e) {
      out.slack = `Slack request failed: ${(e as Error).message}`;
    }
  }
  if (alerts.email.length && ch.alertEmails.length) {
    const key = process.env.RESEND_API_KEY;
    if (!key) out.email = "RESEND_API_KEY is not set";
    else {
      try {
        const { subject, html, text } = emailContent(alerts.email);
        const r = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            from: process.env.ALERT_EMAIL_FROM || "NorthScale <alerts@resend.dev>",
            to: ch.alertEmails,
            subject,
            html,
            text,
          }),
        });
        out.email = r.ok ? true : `Resend responded ${r.status}`;
      } catch (e) {
        out.email = `Email request failed: ${(e as Error).message}`;
      }
    }
  }
  return out;
}
