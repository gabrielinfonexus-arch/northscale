/**
 * Minimal Meta Graph / Marketing API client.
 * - Version is configurable (META_API_VERSION, default v26.0). Marketing API calls to an expired version FAIL
 *   (they are not silently upgraded like the Graph API), so keep it current.
 * - Reads the usage headers (x-business-use-case-usage, x-ad-account-usage, x-app-usage) and slows down
 *   before Meta starts throttling; on throttling errors waits `estimated_time_to_regain_access`.
 * - fetch and sleep are injectable so the client is unit-testable with mocked responses.
 */
import { ConnectorError } from "../types";

export const DEFAULT_META_API_VERSION = "v26.0";

export interface MetaClientOptions {
  token: string;
  version?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onUsage?: (pct: number) => void;
  /** max retries for throttling / transient errors */
  maxRetries?: number;
  /** usage % above which we pause between calls */
  slowDownAt?: number;
  baseUrl?: string;
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

interface MetaErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean; error_user_msg?: string };
}

/** Meta error codes → our error kinds. https://developers.facebook.com/docs/marketing-api/error-reference */
export function classifyMetaError(status: number, body: MetaErrorBody): ConnectorError {
  const e = body.error ?? {};
  const code = e.code ?? status;
  const msg = e.error_user_msg || e.message || `Meta API error ${status}`;
  if (code === 190 || code === 102 || (e.type === "OAuthException" && [458, 459, 460, 463, 464, 467].includes(e.error_subcode ?? 0)))
    return new ConnectorError(msg, "auth", undefined, code);
  if ([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014].includes(code))
    return new ConnectorError(msg, "rate_limit", 60_000, code);
  if (code === 10 || code === 200 || code === 270 || (code >= 200 && code < 300 && status === 403))
    return new ConnectorError(msg, "permission", undefined, code);
  if (code === 803 || status === 404) return new ConnectorError(msg, "not_found", undefined, code);
  if (e.is_transient || status >= 500 || code === 1 || code === 2) return new ConnectorError(msg, "transient", 5_000, code);
  return new ConnectorError(msg, "invalid_request", undefined, code);
}

const USAGE_KEYS = new Set(["call_count", "total_cputime", "total_time", "acc_id_util_pct"]);

/** Highest usage % across the three usage headers, plus how long Meta says to wait (ms). */
export function parseUsageHeaders(h: Headers): { pct: number; waitMs: number } {
  let pct = 0;
  let waitMs = 0;
  const parse = (v: string | null) => {
    if (!v) return null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  const visit = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "number") continue;
      if (k === "estimated_time_to_regain_access") waitMs = Math.max(waitMs, v * 60_000);
      else if (USAGE_KEYS.has(k)) pct = Math.max(pct, v);
    }
  };
  const app = parse(h.get("x-app-usage"));
  if (app && typeof app === "object") visit(app as Record<string, unknown>);
  const acc = parse(h.get("x-ad-account-usage"));
  if (acc && typeof acc === "object") visit(acc as Record<string, unknown>);
  const buc = parse(h.get("x-business-use-case-usage"));
  if (buc && typeof buc === "object")
    for (const list of Object.values(buc as Record<string, unknown>))
      if (Array.isArray(list)) for (const item of list) if (item && typeof item === "object") visit(item as Record<string, unknown>);
  return { pct, waitMs };
}

export class MetaClient {
  readonly version: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private onUsage?: (pct: number) => void;
  private maxRetries: number;
  private slowDownAt: number;
  private baseUrl: string;
  /** highest usage seen by this client */
  maxUsage = 0;
  calls = 0;

  constructor(o: MetaClientOptions) {
    this.token = o.token;
    this.version = o.version ?? DEFAULT_META_API_VERSION;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onUsage = o.onUsage;
    this.maxRetries = o.maxRetries ?? 5;
    this.slowDownAt = o.slowDownAt ?? 75;
    this.baseUrl = o.baseUrl ?? "https://graph.facebook.com";
  }

  url(path: string, params: Record<string, unknown> = {}): string {
    const u = new URL(`${this.baseUrl}/${this.version}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    return u.toString();
  }

  /** GET with retries. Token goes in the Authorization header, never in logs or URLs we store. */
  get<T>(pathOrUrl: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>("GET", pathOrUrl.startsWith("http") ? pathOrUrl : this.url(pathOrUrl, params));
  }

  /**
   * POST — used only to *start* asynchronous insight reports (read-only reporting jobs).
   * NorthScale never POSTs to objects that change campaigns, ad sets, ads or budgets.
   */
  post<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!/\/insights$/.test(path)) throw new Error("Refusing a write call: NorthScale is read-only towards Meta");
    return this.request<T>("POST", this.url(path, params));
  }

  private async request<T>(method: "GET" | "POST", url: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.calls++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers: { Authorization: `Bearer ${this.token}` } });
      } catch (err) {
        if (attempt++ >= this.maxRetries) throw new ConnectorError(`Network error calling Meta: ${(err as Error).message}`, "transient");
        await this.sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      const usage = parseUsageHeaders(res.headers);
      if (usage.pct) {
        this.maxUsage = Math.max(this.maxUsage, usage.pct);
        this.onUsage?.(usage.pct);
      }
      if (res.ok) {
        // be polite: slow down as we approach the limit
        if (usage.pct >= this.slowDownAt) await this.sleep(Math.min(60_000, (usage.pct - this.slowDownAt + 1) * 2_000));
        return (await res.json()) as T;
      }
      const body = (await res.json().catch(() => ({}))) as MetaErrorBody;
      const err = classifyMetaError(res.status, body);
      const retryable = err.kind === "rate_limit" || err.kind === "transient";
      if (!retryable || attempt++ >= this.maxRetries) throw err;
      const wait = Math.max(usage.waitMs, err.retryAfterMs ?? 0, 1000 * 2 ** attempt);
      await this.sleep(Math.min(wait, 15 * 60_000));
    }
  }

  /** Follow `paging.next` until exhausted (or `max` items). */
  async all<T>(path: string, params: Record<string, unknown> = {}, max = 100_000): Promise<T[]> {
    const out: T[] = [];
    let page = await this.get<Paged<T>>(path, params);
    for (;;) {
      out.push(...(page.data ?? []));
      const next = page.paging?.next;
      if (!next || out.length >= max) break;
      page = await this.get<Paged<T>>(next);
    }
    return out;
  }
}
