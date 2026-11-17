import { describe, expect, it, vi } from "vitest";
import { dataLink, planAlerts, type Existing } from "@/server/watchdog/run";
import { emailContent, isValidSlackWebhook, sendNotifications, severityAtLeast, slackPayload } from "@/server/watchdog/notify";
import { encryptSecret } from "@/lib/crypto";
import type { Candidate } from "@/lib/watchdog/rules";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

const NOW = new Date("2026-11-17T12:00:00Z");
const cand = (fp: string, severity: Candidate["severity"] = "WARNING"): Candidate => ({
  ruleKey: fp.split(":")[0],
  severity,
  title: fp,
  message: "m",
  fingerprint: fp,
});
const ex = (fp: string, status: Existing["status"], extra: Partial<Existing> = {}): Existing => ({
  id: "id-" + fp,
  fingerprint: fp,
  status,
  severity: "WARNING",
  mutedUntil: null,
  autoResolved: false,
  ...extra,
});
const kinds = (c: Candidate[], e: Existing[]) =>
  planAlerts(c, e, NOW).map((p) => [p.kind, "c" in p ? p.c.fingerprint : p.id, "notify" in p ? p.notify : undefined]);

describe("Alert lifecycle", () => {
  it("creates new alerts and notifies; de-duplicates by fingerprint", () => {
    expect(kinds([cand("a"), cand("a")], [])).toEqual([["create", "a", true]]);
  });

  it("refreshes open alerts; notifies again only on escalation", () => {
    expect(kinds([cand("a")], [ex("a", "OPEN")])).toEqual([["update", "a", false]]);
    expect(kinds([cand("a", "CRITICAL")], [ex("a", "OPEN")])).toEqual([["update", "a", true]]);
  });

  it("muted alerts stay silent until mutedUntil, then reopen", () => {
    expect(kinds([cand("a")], [ex("a", "MUTED", { mutedUntil: new Date("2026-11-20T00:00:00Z") })])).toEqual([["touch", "a", undefined]]);
    const p = planAlerts([cand("a")], [ex("a", "MUTED", { mutedUntil: new Date("2026-11-16T00:00:00Z") })], NOW)[0];
    expect(p).toMatchObject({ kind: "update", reopen: true, notify: true });
  });

  it("manually resolved alerts stay resolved while the condition persists, unless it gets worse", () => {
    expect(kinds([cand("a")], [ex("a", "RESOLVED")])).toEqual([["touch", "a", undefined]]);
    expect(planAlerts([cand("a", "CRITICAL")], [ex("a", "RESOLVED")], NOW)[0]).toMatchObject({ kind: "update", reopen: true });
  });

  it("auto-resolved alerts reopen when the condition comes back", () => {
    expect(planAlerts([cand("a")], [ex("a", "RESOLVED", { autoResolved: true })], NOW)[0]).toMatchObject({
      kind: "update",
      reopen: true,
      notify: true,
    });
  });

  it("resolves open/muted alerts whose condition cleared, and marks acknowledged ones as cleared", () => {
    const plans = planAlerts(
      [],
      [ex("a", "OPEN"), ex("b", "MUTED"), ex("c", "RESOLVED"), ex("d", "RESOLVED", { autoResolved: true })],
      NOW,
    );
    expect(plans.map((p) => ("id" in p ? p.id : null))).toEqual(["id-a", "id-b", "id-c"]);
    expect(plans.every((p) => p.kind === "resolve")).toBe(true);
  });

  it("builds Data links", () => {
    expect(dataLink("aurora", { platform: "meta", tab: "ads", preset: "last_7", accounts: "c1" })).toBe(
      "/data?client=aurora&platform=meta&tab=ads&preset=last_7&accounts=c1",
    );
    expect(dataLink("aurora")).toBeNull();
  });
});

describe("Notifications", () => {
  const A = {
    severity: "CRITICAL" as const,
    title: "Meta CPA 60% above target",
    message: "CPA $67 vs $42 <script>",
    clientName: "Aurora",
    url: "https://app/data?client=aurora",
  };

  it("severity threshold", () => {
    expect(severityAtLeast("CRITICAL", "WARNING")).toBe(true);
    expect(severityAtLeast("INFO", "WARNING")).toBe(false);
    expect(severityAtLeast("INFO", "INFO")).toBe(true);
  });

  it("formats Slack and email (HTML-escaped)", () => {
    expect(JSON.stringify(slackPayload([A]))).toContain("<https://app/data?client=aurora|View data>");
    const e = emailContent([A]);
    expect(e.subject).toBe("[CRITICAL] Aurora: Meta CPA 60% above target");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.html).not.toContain("<script>");
  });

  it("validates Slack webhook URLs", () => {
    expect(isValidSlackWebhook("https://hooks.slack.com/services/T0/B0/xyz")).toBe(true);
    expect(isValidSlackWebhook("http://hooks.slack.com/services/T0/B0/xyz")).toBe(false);
    expect(isValidSlackWebhook("https://evil.example/services/x")).toBe(false);
  });

  it("posts to the decrypted Slack webhook and to Resend; reports failures without throwing", async () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.RESEND_API_KEY = "re_test";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("ok"))
      .mockResolvedValueOnce(new Response("{}", { status: 422 }));
    const r = await sendNotifications(
      { slack: [A], email: [A] },
      { slackWebhookEncrypted: encryptSecret("https://hooks.slack.com/services/T/B/x"), alertEmails: ["ops@example.com"] },
      fetchImpl,
    );
    expect(r).toEqual({ slack: true, email: "Resend responded 422" });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://hooks.slack.com/services/T/B/x");
    const [url, init] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(init?.body)).to).toEqual(["ops@example.com"]);
    delete process.env.RESEND_API_KEY;
  });

  it("missing Resend key is reported, not thrown", async () => {
    delete process.env.RESEND_API_KEY;
    const r = await sendNotifications({ slack: [], email: [A] }, { slackWebhookEncrypted: null, alertEmails: ["x@y.z"] }, vi.fn());
    expect(r.email).toBe("RESEND_API_KEY is not set");
  });
});
