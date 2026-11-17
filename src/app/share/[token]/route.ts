import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { createSession } from "@/server/auth";
import { SHARE_FORBIDDEN_PAGES } from "@/lib/permissions";

/** Public read-only link for a client: starts a limited session and opens the first allowed page. */
export async function GET(req: Request, ctx: RouteContext<"/share/[token]">) {
  const { token } = await ctx.params;
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { client: { select: { slug: true, archivedAt: true } } },
  });
  const now = new Date();
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt <= now) || link.client.archivedAt)
    return new NextResponse("This link has expired or was revoked.", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  await createSession({ shareLinkId: link.id, expiresAt: link.expiresAt ?? new Date(Date.now() + 7 * 86_400_000) });
  await prisma.shareLink.update({ where: { id: link.id }, data: { lastUsedAt: now } });
  const page = link.allowedPages.find((p) => !SHARE_FORBIDDEN_PAGES.includes(p)) ?? "dashboard";
  return NextResponse.redirect(new URL(`/${page}?client=${link.client.slug}`, req.url));
}
