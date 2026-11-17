"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { saveNotificationSettings, sendTestNotification } from "@/server/watchdog-actions";

const field = "h-8 w-full rounded-md border border-border bg-surface px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring";

export function NotificationSettings({
  settings,
}: {
  settings: {
    slackConfigured: boolean;
    slackHint: string | null;
    alertEmails: string[];
    minSeverity: "CRITICAL" | "WARNING" | "INFO";
    resendConfigured: boolean;
    canEdit: boolean;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [slack, setSlack] = useState("");
  const [emails, setEmails] = useState(settings.alertEmails.join(", "));
  const [min, setMin] = useState(settings.minSeverity);
  const [msg, setMsg] = useState<string | null>(null);
  const ro = !settings.canEdit;

  const save = (removeSlack = false) =>
    start(async () => {
      const r = await saveNotificationSettings({
        slackWebhook: removeSlack ? "" : slack.trim() || undefined,
        alertEmails: emails
          .split(/[\s,;]+/)
          .map((e) => e.trim())
          .filter(Boolean),
        minSeverity: min,
      });
      setMsg(r.ok ? "Saved." : r.error);
      if (r.ok) {
        setSlack("");
        router.refresh();
      }
    });

  const test = () =>
    start(async () => {
      const r = await sendTestNotification();
      if (!r.ok) return setMsg(r.error);
      const parts = [
        r.slack !== undefined && `Slack: ${r.slack === true ? "sent" : r.slack}`,
        r.email !== undefined && `Email: ${r.email === true ? "sent" : r.email}`,
      ].filter(Boolean);
      setMsg(parts.join(" · ") || "Nothing to send.");
    });

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-5" data-testid="notification-settings">
      <p className="text-[13px] text-muted">
        New alerts at or above the minimum severity are sent once, when they open (or reopen, or get worse). Each rule can turn email or
        Slack off in the Rules tab. These settings apply to every client in the organization.
      </p>
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium">Slack incoming webhook</span>
        <input
          className={field}
          type="password"
          autoComplete="off"
          disabled={ro}
          placeholder={
            settings.slackConfigured ? `Saved (${settings.slackHint}) — paste a new URL to replace` : "https://hooks.slack.com/services/…"
          }
          value={slack}
          onChange={(e) => setSlack(e.target.value)}
          aria-label="Slack webhook URL"
        />
        <span className="text-[12px] text-subtle">Stored encrypted (AES-256-GCM); it is never shown again in full.</span>
      </label>
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium">Email recipients</span>
        <input
          className={field}
          disabled={ro}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="ops@agency.com, owner@agency.com"
          aria-label="Alert emails"
        />
        {!settings.resendConfigured && (
          <span className="text-[12px] text-warn">Email needs RESEND_API_KEY (and ALERT_EMAIL_FROM) in the server environment.</span>
        )}
      </label>
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium">Minimum severity</span>
        <select
          className={`${field} w-48`}
          disabled={ro}
          value={min}
          onChange={(e) => setMin(e.target.value as typeof min)}
          aria-label="Minimum severity"
        >
          <option value="CRITICAL">Critical only</option>
          <option value="WARNING">Warning and critical</option>
          <option value="INFO">Everything (incl. info)</option>
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {!ro && (
          <Button disabled={pending} onClick={() => save()}>
            Save
          </Button>
        )}
        {!ro && (
          <Button variant="outline" disabled={pending} onClick={test}>
            Send test
          </Button>
        )}
        {!ro && settings.slackConfigured && (
          <Button variant="ghost" disabled={pending} onClick={() => save(true)}>
            Remove Slack webhook
          </Button>
        )}
        {ro && <span className="text-[12px] text-muted">Only owners and admins can change notifications.</span>}
        {msg && (
          <span role="status" className="text-[12px] text-muted">
            {msg}
          </span>
        )}
      </div>
    </Card>
  );
}
