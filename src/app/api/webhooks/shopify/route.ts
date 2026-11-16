import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { parseCredential, syncSingleOrder } from "@/server/connectors/shopify/connector";
import { refreshReportingViewsThrottled } from "@/server/sync/writer";

/**
 * Shopify webhooks: orders/create, orders/updated, refunds/create.
 * Verifies X-Shopify-Hmac-Sha256 (base64 HMAC-SHA256 of the raw body) with the app secret,
 * answers 200 immediately and re-reads the order from the API in the background.
 */
const TOPICS = new Set(["orders/create", "orders/updated", "orders/paid", "orders/cancelled", "refunds/create"]);

function verify(raw: string, hmac: string, secret: string) {
  const digest = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(digest),
    b = Buffer.from(hmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const shop = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!shop || !hmac) return NextResponse.json({ error: "missing headers" }, { status: 401 });

  const connections = await prisma.connection.findMany({ where: { platform: "SHOPIFY", externalId: shop }, include: { credential: true } });
  if (!connections.length) return NextResponse.json({ ok: true, ignored: "unknown shop" });

  // the signing secret is the app's client secret (Dev Dashboard / OAuth apps) or SHOPIFY_WEBHOOK_SECRET (legacy custom apps)
  const secrets = new Set<string>();
  if (process.env.SHOPIFY_WEBHOOK_SECRET) secrets.add(process.env.SHOPIFY_WEBHOOK_SECRET);
  if (process.env.SHOPIFY_API_SECRET) secrets.add(process.env.SHOPIFY_API_SECRET);
  for (const c of connections) {
    const enc = c.encryptedToken ?? c.credential?.encryptedToken;
    if (!enc) continue;
    try {
      const cred = parseCredential(decryptSecret(enc));
      if (cred.clientSecret) secrets.add(cred.clientSecret);
    } catch {
      /* ignore */
    }
  }
  if (![...secrets].some((s) => verify(raw, hmac, s))) return NextResponse.json({ error: "invalid hmac" }, { status: 401 });
  if (!TOPICS.has(topic)) return NextResponse.json({ ok: true, ignored: topic });

  let payload: { admin_graphql_api_id?: string; order_id?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const orderGid =
    topic === "refunds/create"
      ? payload.order_id
        ? `gid://shopify/Order/${payload.order_id}`
        : null
      : (payload.admin_graphql_api_id ?? null);
  if (!orderGid) return NextResponse.json({ ok: true, ignored: "no order id" });

  after(async () => {
    for (const c of connections) {
      const enc = c.encryptedToken ?? c.credential?.encryptedToken;
      if (!enc) continue;
      try {
        await syncSingleOrder(
          {
            connectionId: c.id,
            clientId: c.clientId,
            externalId: c.externalId,
            currency: c.currency,
            timezone: c.timezone,
            token: decryptSecret(enc),
            meta: {},
          },
          orderGid,
        );
        revalidateTag(`client:${c.clientId}`, "max");
      } catch (e) {
        console.error(`[shopify webhook] ${topic} ${shop}:`, (e as Error).message);
      }
    }
    await refreshReportingViewsThrottled().catch(() => {});
  });
  return NextResponse.json({ ok: true });
}
