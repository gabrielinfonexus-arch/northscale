import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { signState } from "@/lib/crypto";
import { assertCanEdit } from "@/server/auth";
import { getConnector, hasConnector } from "@/server/connectors/registry";
import { PLATFORM_SLUG } from "@/server/connect";
import { normalizeShop } from "@/server/connectors/shopify/client";
import { getMetaAppConfig, metaMockOn } from "@/server/meta-app";

/** Step 1 of OAuth: send the user to the platform's consent screen. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/connect/[platform]/start">) {
  const { platform: slug } = await ctx.params;
  const platform = PLATFORM_SLUG[slug];
  const clientId = req.nextUrl.searchParams.get("client") ?? "";
  const back = new URL("/sync-status", req.nextUrl.origin);
  if (!platform || !hasConnector(platform)) return NextResponse.redirect(new URL(`${back}?error=unsupported`));
  try {
    await assertCanEdit(clientId);
  } catch {
    return NextResponse.redirect(new URL(`${back}?error=forbidden`));
  }
  const oauth = getConnector(platform).oauth;
  if (!oauth) return NextResponse.redirect(new URL(`${back}?error=no_oauth`));
  let metaExtra: Record<string, string> | undefined;
  if (platform === "META" && !metaMockOn()) {
    const cfg = await getMetaAppConfig();
    // not set up yet: the one-time setup page (with the values to copy into Meta) instead of an error
    if (!cfg) return NextResponse.redirect(new URL(`/connect/meta/setup?client=${encodeURIComponent(clientId)}`, req.nextUrl.origin));
    metaExtra = { appId: cfg.appId, ...(cfg.configId ? { configId: cfg.configId } : {}) };
  }
  if (
    platform === "GOOGLE" &&
    !(process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_DEVELOPER_TOKEN) &&
    process.env.GOOGLE_ADS_MOCK !== "1"
  )
    return NextResponse.redirect(new URL(`${back}?error=google_not_configured`));
  let shop = "";
  if (platform === "SHOPIFY") {
    try {
      shop = normalizeShop(req.nextUrl.searchParams.get("shop") ?? "");
    } catch {
      return NextResponse.redirect(new URL(`${back}?error=${encodeURIComponent("Enter the store's myshopify.com domain")}`));
    }
  }
  if (platform === "SHOPIFY" && !process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_MOCK !== "1")
    return NextResponse.redirect(new URL(`${back}?error=shopify_oauth_not_configured`));
  const nonce = randomBytes(16).toString("base64url");
  const state = signState({ c: clientId, p: platform, n: nonce, ...(shop ? { s: shop } : {}) });
  const redirectUri = `${process.env.APP_URL ?? req.nextUrl.origin}/api/connect/${slug}/callback`;
  let target: string;
  try {
    target = oauth.authorizeUrl(state, redirectUri, shop ? { shop } : metaExtra);
  } catch (e) {
    return NextResponse.redirect(new URL(`${back}?error=${encodeURIComponent((e as Error).message)}`));
  }
  const res = NextResponse.redirect(target);
  res.cookies.set("ns_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 900,
    path: "/",
  });
  return res;
}
