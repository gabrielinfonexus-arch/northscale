/**
 * Shopify Admin GraphQL client.
 * - Version configurable via SHOPIFY_API_VERSION (default 2026-10).
 * - Cost-based rate limit: reads extensions.cost.throttleStatus and waits for the bucket to refill;
 *   THROTTLED errors (HTTP 200 with errors) are retried.
 * - Token in the X-Shopify-Access-Token header only.
 */
import { ConnectorError } from "../types";

export const DEFAULT_SHOPIFY_API_VERSION = "2026-10";

export interface ShopifyClientOptions {
  shop: string; // "brand.myshopify.com"
  token: string;
  version?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  onUsage?: (pct: number) => void;
}

interface GqlError {
  message: string;
  extensions?: { code?: string };
}
interface GqlResponse<T> {
  data?: T;
  errors?: GqlError[] | string;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
    };
  };
}

export function normalizeShop(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const host = s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host))
    throw new ConnectorError("Use the store's myshopify.com domain, e.g. brand.myshopify.com", "invalid_request");
  return host;
}

export function classifyShopifyError(status: number, body: GqlResponse<unknown> | undefined): ConnectorError {
  const errs = Array.isArray(body?.errors) ? body!.errors : body?.errors ? [{ message: String(body.errors) }] : [];
  const msg = errs.map((e) => e.message).join("; ") || `Shopify API error ${status}`;
  if (status === 401 || /invalid api key or access token/i.test(msg)) return new ConnectorError(msg, "auth", undefined, status);
  if (status === 402) return new ConnectorError(`Store is frozen / unpaid: ${msg}`, "permission", undefined, status);
  if (status === 403 || errs.some((e) => e.extensions?.code === "ACCESS_DENIED"))
    return new ConnectorError(`Missing access scope: ${msg}`, "permission", undefined, status);
  if (status === 404) return new ConnectorError("Store not found", "not_found", undefined, status);
  if (status === 429 || errs.some((e) => e.extensions?.code === "THROTTLED"))
    return new ConnectorError(msg, "rate_limit", 2_000, "THROTTLED");
  if (status >= 500 || errs.some((e) => e.extensions?.code === "INTERNAL_SERVER_ERROR"))
    return new ConnectorError(msg, "transient", 3_000, status);
  return new ConnectorError(msg, "invalid_request", undefined, status);
}

export class ShopifyClient {
  readonly version: string;
  readonly shop: string;
  private o: ShopifyClientOptions;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  maxUsage = 0;
  calls = 0;

  constructor(o: ShopifyClientOptions) {
    this.o = o;
    this.shop = normalizeShop(o.shop);
    this.version = o.version ?? DEFAULT_SHOPIFY_API_VERSION;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.calls++;
      let res: Response;
      try {
        res = await this.fetchImpl(`https://${this.shop}/admin/api/${this.version}/graphql.json`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Shopify-Access-Token": this.o.token },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        if (attempt++ >= (this.o.maxRetries ?? 5))
          throw new ConnectorError(`Network error calling Shopify: ${(err as Error).message}`, "transient");
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = (await res.json().catch(() => undefined)) as GqlResponse<T> | undefined;
      const t = body?.extensions?.cost?.throttleStatus;
      if (t) {
        const pct = ((t.maximumAvailable - t.currentlyAvailable) / t.maximumAvailable) * 100;
        this.maxUsage = Math.max(this.maxUsage, pct);
        this.o.onUsage?.(pct);
      }
      if (res.ok && body?.data && !(Array.isArray(body.errors) && body.errors.length)) {
        // keep enough budget for the next page
        const need = body.extensions?.cost?.requestedQueryCost ?? 0;
        if (t && t.currentlyAvailable < need * 1.5)
          await this.sleep(Math.ceil(((need * 1.5 - t.currentlyAvailable) / t.restoreRate) * 1000));
        return body.data;
      }
      const err = classifyShopifyError(res.status, body);
      if (!(err.kind === "rate_limit" || err.kind === "transient") || attempt++ >= (this.o.maxRetries ?? 6)) throw err;
      const wait = t ? Math.ceil(((body?.extensions?.cost?.requestedQueryCost ?? 100) / t.restoreRate) * 1000) : 1000 * 2 ** attempt;
      await this.sleep(Math.max(wait, err.retryAfterMs ?? 0));
    }
  }
}
