/**
 * Google Ads API (REST) client.
 * - Version configurable via GOOGLE_ADS_API_VERSION (default v26). Requests to a sunset version fail.
 * - Auth: OAuth refresh token → short-lived access token (cached), plus the developer-token header and,
 *   for accounts reached through a manager (MCC), the login-customer-id header.
 * - Read-only: only search / searchStream / listAccessibleCustomers are ever called.
 * - fetch and sleep are injectable for unit tests.
 */
import { ConnectorError } from "../types";

export const DEFAULT_GOOGLE_ADS_API_VERSION = "v26";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleAdsClientOptions {
  refreshToken: string;
  developerToken: string;
  clientId: string;
  clientSecret: string;
  loginCustomerId?: string | null;
  version?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
  /** daily operation budget of the developer token (Basic access: 15,000) — for usage % */
  dailyOperations?: number;
  onUsage?: (pct: number) => void;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { "@type"?: string; retryDelay?: string; errors?: { errorCode?: Record<string, string>; message?: string }[] }[];
  };
}

const digits = (id: string) => id.replace(/\D/g, "");

/** Map Google Ads failures to connector error kinds. */
export function classifyGoogleError(httpStatus: number, raw: unknown): ConnectorError {
  const body = (Array.isArray(raw) ? raw[0] : raw) as GoogleErrorBody | undefined;
  const e = body?.error ?? {};
  const failures = (e.details ?? []).flatMap((d) => d.errors ?? []);
  const codes = failures.flatMap((f) => Object.entries(f.errorCode ?? {}).map(([k, v]) => `${k}:${v}`));
  const msg = failures[0]?.message ?? e.message ?? `Google Ads API error ${httpStatus}`;
  const retry = (e.details ?? []).find((d) => d.retryDelay)?.retryDelay;
  const retryMs = retry ? Math.ceil(parseFloat(retry) * 1000) : undefined;
  const has = (s: string) => codes.some((c) => c.includes(s));

  if (has("DEVELOPER_TOKEN_NOT_APPROVED") || has("DEVELOPER_TOKEN_PROHIBITED"))
    return new ConnectorError(
      `Developer token not approved for this account (${msg}). Apply for Basic access in the API Center.`,
      "permission",
      undefined,
      "DEVELOPER_TOKEN",
    );
  if (httpStatus === 401 || e.status === "UNAUTHENTICATED" || has("OAUTH_TOKEN") || has("authenticationError"))
    return new ConnectorError(msg, "auth", undefined, e.status);
  if (httpStatus === 429 || e.status === "RESOURCE_EXHAUSTED" || has("quotaError"))
    return new ConnectorError(msg, "rate_limit", retryMs ?? 30_000, e.status);
  if (httpStatus === 403 || e.status === "PERMISSION_DENIED" || has("authorizationError"))
    return new ConnectorError(msg, "permission", undefined, codes[0] ?? e.status);
  if (httpStatus === 404 || e.status === "NOT_FOUND") return new ConnectorError(msg, "not_found", undefined, e.status);
  if (httpStatus >= 500 || e.status === "UNAVAILABLE" || e.status === "INTERNAL" || e.status === "DEADLINE_EXCEEDED")
    return new ConnectorError(msg, "transient", retryMs ?? 5_000, e.status);
  return new ConnectorError(msg, "invalid_request", undefined, codes[0] ?? e.status);
}

export class GoogleAdsClient {
  readonly version: string;
  private o: GoogleAdsClientOptions;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private access: { token: string; exp: number } | null = null;
  operations = 0;

  constructor(o: GoogleAdsClientOptions) {
    this.o = o;
    this.version = o.version ?? DEFAULT_GOOGLE_ADS_API_VERSION;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get base() {
    return `${this.o.baseUrl ?? "https://googleads.googleapis.com"}/${this.version}`;
  }

  /** Exchange the refresh token for an access token (cached until 1 minute before expiry). */
  async accessToken(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.o.refreshToken,
        client_id: this.o.clientId,
        client_secret: this.o.clientSecret,
      }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !j.access_token) {
      if (j.error === "invalid_grant")
        throw new ConnectorError("Google refresh token expired or revoked — reconnect the account.", "auth", undefined, "invalid_grant");
      throw new ConnectorError(
        `Google OAuth error: ${j.error_description ?? j.error ?? res.status}`,
        res.status >= 500 ? "transient" : "auth",
      );
    }
    this.access = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  private async headers(loginCustomerId?: string | null) {
    const h: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "developer-token": this.o.developerToken,
      "content-type": "application/json",
    };
    const login = loginCustomerId ?? this.o.loginCustomerId;
    if (login) h["login-customer-id"] = digits(login);
    return h;
  }

  private async call<T>(method: "GET" | "POST", url: string, body?: unknown, loginCustomerId?: string | null): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.operations++;
      if (this.o.dailyOperations) this.o.onUsage?.(Math.min(100, (this.operations / this.o.dailyOperations) * 100));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: await this.headers(loginCustomerId),
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (err instanceof ConnectorError) throw err;
        if (attempt++ >= (this.o.maxRetries ?? 5))
          throw new ConnectorError(`Network error calling Google Ads: ${(err as Error).message}`, "transient");
        await this.sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const err = classifyGoogleError(res.status, await res.json().catch(() => ({})));
      if (!(err.kind === "rate_limit" || err.kind === "transient") || attempt++ >= (this.o.maxRetries ?? 5)) throw err;
      await this.sleep(Math.min(Math.max(err.retryAfterMs ?? 0, 1000 * 2 ** attempt), 10 * 60_000));
    }
  }

  /** Run a GAQL query with searchStream and return all rows. */
  async query<T = Record<string, unknown>>(customerId: string, gaql: string, loginCustomerId?: string | null): Promise<T[]> {
    const batches = await this.call<{ results?: T[] }[] | { results?: T[] }>(
      "POST",
      `${this.base}/customers/${digits(customerId)}/googleAds:searchStream`,
      { query: gaql },
      loginCustomerId,
    );
    const list = Array.isArray(batches) ? batches : [batches];
    return list.flatMap((b) => b.results ?? []);
  }

  /** Customers the OAuth user can access directly (resource names "customers/123"). */
  async listAccessibleCustomers(): Promise<string[]> {
    const r = await this.call<{ resourceNames?: string[] }>("GET", `${this.base}/customers:listAccessibleCustomers`, undefined, null);
    return (r.resourceNames ?? []).map((n) => n.split("/")[1]);
  }
}

export function formatCustomerId(id: string): string {
  const d = digits(id);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}
