import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
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
  const state = verifyState<{ c: string; p: string; n: string }>(sp.get("state") ?? "");
  if (!state || state.n !== req.cookies.get("ns_oauth_nonce")?.value || PLATFORM_SLUG[slug] !== state.p) return back("error=invalid_state");
  let user;
  try {
    user = await assertCanEdit(state.c);
  } catch {
    return back("error=forbidden");
  }
  const connector = getConnector(PLATFORM_SLUG[slug]);
  try {
    const redirectUri = `${process.env.APP_URL ?? req.nextUrl.origin}/api/connect/${slug}/callback`;
    const t = await connector.oauth!.exchangeCode(sp.get("code") ?? "", redirectUri);
    const credentialId = await saveCredential({
      organizationId: user.organizationId,
      platform: PLATFORM_SLUG[slug],
      kind: "oauth",
      token: t.token,
      label: t.userName ? `${t.userName} (Facebook login)` : "Facebook login",
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
