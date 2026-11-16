/**
 * Pluggable connector interface. Every platform (Meta, Google Ads, Shopify, TikTok, Klaviyo, Amazon…)
 * implements this, and the sync engine / queue / UI never need to know which one they are talking to.
 *
 * Connectors are READ-ONLY towards the platforms: they never create, pause or edit anything.
 */
import type { DateRange } from "@/lib/periods";

export type ConnectorPlatform = "META" | "GOOGLE" | "SHOPIFY" | "OTHER_REVENUE";

/** An account the credential can see (shown in the account picker). */
export interface ExternalAccount {
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
  /** e.g. Business Manager / MCC name */
  parent?: string | null;
  /** Google Ads: manager account (MCC) to send as login-customer-id */
  loginCustomerId?: string | null;
}

/** What a connector needs to run for one connection. */
export interface ConnectorContext {
  connectionId: string;
  clientId: string;
  externalId: string;
  currency: string;
  timezone: string;
  token: string;
  /** Google Ads manager account id (login-customer-id), when reached through an MCC */
  loginCustomerId?: string | null;
  meta: Record<string, unknown>;
  /** Called with platform usage (0..100) whenever rate-limit headers are seen. */
  onUsage?: (pct: number) => void;
  log?: (msg: string) => void;
}

export interface SyncResult {
  rows: number;
  warnings: string[];
  /** Highest rate-limit usage seen during the call (0..100). */
  usagePct?: number;
  /** Values merged into connection.meta (e.g. audience segments availability, attribution setting). */
  metaPatch?: Record<string, unknown>;
}

export type HealthStatus = "OK" | "ERROR" | "TOKEN_EXPIRED";

export interface HealthResult {
  status: HealthStatus;
  message?: string;
  /** Platform-specific account state for the Watchdog (disabled, spend cap…). */
  account?: Record<string, unknown>;
}

export interface OAuthSupport {
  /** URL to send the user to. `extra` carries platform inputs such as the Shopify shop domain. */
  authorizeUrl(state: string, redirectUri: string, extra?: Record<string, string>): string;
  /** Exchange the callback code for a long-lived token. `extra` = callback query params (e.g. shop). */
  exchangeCode(
    code: string,
    redirectUri: string,
    extra?: Record<string, string>,
  ): Promise<{ token: string; expiresAt: Date | null; userId?: string; userName?: string }>;
}

export interface Connector {
  platform: ConnectorPlatform;
  /** OAuth support (optional — some platforms use API tokens only). */
  oauth?: OAuthSupport;
  /** Validate a token and describe who it belongs to. */
  inspectToken(token: string): Promise<{ id: string; name: string; expiresAt: Date | null; scopes: string[] }>;
  listAccounts(token: string): Promise<ExternalAccount[]>;
  /** Daily insights at every level + entity dimensions for the range. Idempotent (replaces the range). */
  syncRange(ctx: ConnectorContext, range: DateRange): Promise<SyncResult>;
  /** Breakdown tables for the range. Idempotent. */
  syncBreakdowns(ctx: ConnectorContext, range: DateRange): Promise<SyncResult>;
  /** Creatives / ad metadata (thumbnails, copy, URLs). */
  syncCreatives?(ctx: ConnectorContext): Promise<SyncResult>;
  healthCheck(ctx: ConnectorContext): Promise<HealthResult>;
  /** Subscribe to platform webhooks for near-real-time updates (Shopify orders). */
  registerWebhooks?(ctx: ConnectorContext, callbackUrl: string): Promise<{ registered: string[]; warnings: string[] }>;
}

/** Errors every connector maps its platform errors into, so the engine can react uniformly. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "rate_limit" | "permission" | "not_found" | "invalid_request" | "transient",
    public readonly retryAfterMs?: number,
    public readonly code?: number | string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
