/** Who may see which page. Shared by the server (enforcement) and the sidebar (hiding links). */
export type Role = "OWNER" | "ADMIN" | "ANALYST" | "CLIENT_VIEWER";

/** Pages a Client Viewer can be given (per client). Management pages are never available to viewers. */
export const VIEWER_PAGES: { id: string; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "data", label: "Data" },
  { id: "chart-notes", label: "Chart Notes" },
  { id: "targets", label: "Targets" },
  { id: "pnl", label: "P&L" },
  { id: "ai-insights", label: "AI Insights" },
  { id: "watchdog", label: "Watchdog" },
  { id: "hive-mind", label: "Hive-Mind" },
];
export const DEFAULT_VIEWER_PAGES = ["dashboard", "data", "targets"];
/** Never on public links (no account to keep a chat history, and the AI costs money). */
export const SHARE_FORBIDDEN_PAGES = ["hive-mind"];

const STAFF_PAGES = [
  "watchdog",
  "hive-mind",
  "dashboard",
  "data",
  "chart-notes",
  "targets",
  "pnl",
  "ai-insights",
  "other-revenue",
  "sync-status",
  "sync-overview",
  "connect",
  "help",
];

export interface PageAccessUser {
  role: Role;
  kind: "user" | "share";
  /** viewers: clientId → allowed page ids */
  viewerPages: Record<string, string[]> | null;
}

/** Can this user open `page` (first URL segment) — for `clientId` when the page is client-specific? */
export function canSeePage(u: PageAccessUser, page: string, clientId?: string | null): boolean {
  if (u.role === "OWNER" || u.role === "ADMIN") return true;
  if (u.role === "ANALYST") return STAFF_PAGES.includes(page);
  if (page === "help") return u.kind === "user";
  if (u.kind === "share" && SHARE_FORBIDDEN_PAGES.includes(page)) return false;
  const vp = u.viewerPages ?? {};
  if (clientId) return (vp[clientId] ?? []).includes(page);
  return Object.values(vp).some((p) => p.includes(page));
}

export const isAdmin = (u: { role: Role }) => u.role === "OWNER" || u.role === "ADMIN";
