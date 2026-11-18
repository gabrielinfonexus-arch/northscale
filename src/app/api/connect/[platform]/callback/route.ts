import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyState } from "@/lib/crypto";
import { assertCanEdit } from "@/server/auth";
import { getConnector } from "@/server/connectors/registry";
import { PLATFORM_SLUG, saveCredential } from "@/server/connect";

/** Step 2 of OAuth: verify state, exchange the code for a long-lived token, store it encrypted, pick accounts. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/connect/[platform]/callback">) {
  const { platform: slug } = await ctx.params;
  const back = (q: string) => NextResponse.redirect(new URL(`/sync-status?${q}`, req.nextUrl.origin));
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return back(`error=${encodeURIComponent(sp.get("error_description") ?? sp.get("error")!)}`);
  const state = verifyState<{ c: string; p: string; n: string; s?: string }>(sp.get("state") ?? "");
  if (!state || state.n !== req.cookies.get("ns_oauth_nonce")?.value || PLATFORM_SLUG[slug] !== state.p) return back("error=invalid_state");
  if (slug === "shopify") {
    // the shop must be the one the user typed, and Shopify signs the callback query with the app secret
    if (!state.s || !sp.get("shop") || sp.get("shop")!.toLowerCase() !== state.s) return back("error=invalid_state");
    if (process.env.SHOPIFY_MOCK !== "1" && !validShopifyHmac(sp)) return back("error=invalid_state");
  }
  let user;
  try {
    user = await assertCanEdit(state.c);
  } catch {
    return back("error=forbidden");
  }
  const connector = getConnector(PLATFORM_SLUG[slug]);
  try {
    const redirectUri = `${process.env.APP_URL ?? req.nextUrl.origin}/api/connect/${slug}/callback`;
    const t = await connector.oauth!.exchangeCode(
      sp.get("code") ?? "",
      redirectUri,
      sp.get("shop") ? { shop: sp.get("shop")! } : undefined,
    );
    const credentialId = await saveCredential({
      organizationId: user.organizationId,
      platform: PLATFORM_SLUG[slug],
      kind: "oauth",
      token: t.token,
      label: `${t.userName ?? "Signed-in user"} (${slug === "google" ? "Google" : slug === "shopify" ? "Shopify" : "Facebook"} login)`,
      externalUserId: t.userId,
      expiresAt: t.expiresAt,
      createdById: user.id,
    });
    const client = await prisma.client.findUnique({ where: { id: state.c }, select: { slug: true } });
    const res = NextResponse.redirect(
      new URL(`/connect/${slug}?credential=${credentialId}&client=${client?.slug ?? ""}`, req.nextUrl.origin),
    );
    res.cookies.delete("ns_oauth_nonce");
    return res;
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message.slice(0, 200))}`);
  }
}

/** Shopify OAuth callback HMAC: sorted query params (minus hmac) signed with the app secret. */
function validShopifyHmac(sp: URLSearchParams): boolean {
  const hmac = sp.get("hmac");
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!hmac || !secret) return false;
  const msg = [...sp.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(msg).digest("hex");
  return digest.length === hmac.length && timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

/** Syncs started from here run after the response (or as Inngest steps): allow the platform maximum. */
export const maxDuration = 300;
