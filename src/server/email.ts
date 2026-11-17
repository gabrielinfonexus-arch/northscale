import "server-only";

/** Transactional email via Resend (invites, password resets). Returns an error string instead of throwing. */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<true | string> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "Email is not configured (RESEND_API_KEY).";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.ALERT_EMAIL_FROM || "NorthScale <alerts@resend.dev>",
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
      }),
    });
    return r.ok ? true : `Email provider responded ${r.status}.`;
  } catch (e) {
    return `Email failed: ${(e as Error).message}`;
  }
}

/** Absolute URL for links in emails. Falls back to the request origin passed by the caller. */
export function absoluteUrl(path: string, origin?: string | null) {
  const base = (process.env.APP_URL || origin || "http://localhost:3000").replace(/\/$/, "");
  return base + path;
}
