import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { accessibleClientIds, getCurrentUser } from "@/server/auth";

const Q = z.object({
  client: z.string().min(1),
  conn: z.string().min(1),
  ad: z.string().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Daily series for one ad (creative preview chart). Read-only, permission-checked. */
export async function GET(req: NextRequest) {
  const parsed = Q.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { client, conn, ad, from, to } = parsed.data;
  const user = await getCurrentUser();
  if (!(await accessibleClientIds(user)).includes(client)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await prisma.$queryRawUnsafe<
    { date: string; spend: number; purchases: number; value: number; impressions: number; clicks: number }[]
  >(
    `SELECT to_char(a.date, 'YYYY-MM-DD') AS date,
            SUM(a.spend * fx_factor(a.currency, c.currency, a.date))::float8 AS spend, SUM(a.purchases)::float8 AS purchases,
            SUM(a."purchaseValue" * fx_factor(a.currency, c.currency, a.date))::float8 AS value,
            SUM(a.impressions)::float8 AS impressions, SUM(a.clicks)::float8 AS clicks
     FROM ad_insights_daily a JOIN clients c ON c.id = a."clientId"
     WHERE a."clientId" = $1 AND a."connectionId" = $2 AND a.level = 'AD' AND a."entityId" = $3 AND a.attribution = 'default'
       AND a.date BETWEEN $4::date AND $5::date
     GROUP BY 1 ORDER BY 1`,
    client,
    conn,
    ad,
    from,
    to,
  );
  return NextResponse.json({ rows });
}
