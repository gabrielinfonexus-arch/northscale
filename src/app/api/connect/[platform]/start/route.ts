import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { signState } from "@/lib/crypto";
import { assertCanEdit } from "@/server/auth";
import { getConnector, hasConnector } from "@/server/connectors/registry";
import { PLATFORM_SLUG } from "@/server/connect";

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
  if (platform === "META" && !process.env.META_APP_ID && process.env.META_MOCK !== "1")
    return NextResponse.redirect(new URL(`${back}?error=meta_not_configured`));
  const nonce = randomBytes(16).toString("base64url");
  const state = signState({ c: clientId, p: platform, n: nonce });
  const redirectUri = `${process.env.APP_URL ?? req.nextUrl.origin}/api/connect/${slug}/callback`;
  const res = NextResponse.redirect(oauth.authorizeUrl(state, redirectUri));
  res.cookies.set("ns_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 900,
    path: "/",
  });
  return res;
}
