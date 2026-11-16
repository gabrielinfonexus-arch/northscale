import { prisma } from "@/lib/db";

/** Generated placeholder thumbnails for the demo creatives (no external image hosts needed). */
export async function GET(_req: Request, ctx: RouteContext<"/api/demo/thumb/[id]">) {
  const { id } = await ctx.params;
  const cr = await prisma.creative.findFirst({ where: { adExternalId: id }, select: { name: true, type: true, headline: true } });
  let h = 0;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
  h ^= h >>> 15;
  const hue = h % 360;
  const hue2 = (hue + 40) % 360;
  const type = cr?.type ?? "IMAGE";
  const title = (cr?.headline ?? cr?.name ?? "Creative").replace(/[<>&"]/g, "").slice(0, 28);
  const icon =
    type === "VIDEO"
      ? `<circle cx="200" cy="170" r="44" fill="rgba(255,255,255,.85)"/><path d="M188 148 L222 170 L188 192 Z" fill="hsl(${hue},45%,35%)"/>`
      : type === "CAROUSEL"
        ? `<rect x="120" y="120" width="70" height="90" rx="8" fill="rgba(255,255,255,.55)"/><rect x="165" y="110" width="70" height="110" rx="8" fill="rgba(255,255,255,.85)"/><rect x="210" y="120" width="70" height="90" rx="8" fill="rgba(255,255,255,.55)"/>`
        : `<circle cx="200" cy="160" r="52" fill="rgba(255,255,255,.75)"/><rect x="170" y="200" width="60" height="22" rx="6" fill="rgba(255,255,255,.6)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,72%)"/><stop offset="1" stop-color="hsl(${hue2},50%,48%)"/></linearGradient></defs>
<rect width="400" height="400" fill="url(#g)"/>${icon}
<text x="200" y="300" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="600" fill="#fff">${title}</text>
<text x="200" y="330" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="14" fill="rgba(255,255,255,.85)">${type.toLowerCase()}</text></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
}
