import "server-only";
import type { Connector, ConnectorPlatform } from "./types";
import { metaConnector } from "./meta/connector";
import { googleConnector } from "./google/connector";
import { shopifyConnector } from "./shopify/connector";

/** Add new platforms here (Google in phase 4, Shopify in phase 5, later TikTok, Klaviyo, Amazon…). */
const CONNECTORS: Partial<Record<ConnectorPlatform, Connector>> = {
  META: metaConnector,
  GOOGLE: googleConnector,
  SHOPIFY: shopifyConnector,
};

export function getConnector(platform: ConnectorPlatform): Connector {
  const c = CONNECTORS[platform];
  if (!c) throw new Error(`No connector for ${platform} yet`);
  return c;
}

export function hasConnector(platform: string): platform is ConnectorPlatform {
  return platform in CONNECTORS;
}
