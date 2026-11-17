import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every route:
 *  1. Optional extra gate: SITE_PASSWORD (HTTP Basic auth) in front of everything, e.g. while a staging URL is shared.
 *  2. Signed-out visitors go to /login (API routes get 401). The session itself is validated on the server
 *     (src/server/auth.ts); this only checks that a session cookie is present.
 * Webhooks and the Inngest endpoint are excluded: they verify their own signatures / keys.
 */
const SESSION_COOKIE = "ns_session";
const PUBLIC = [/^\/login$/, /^\/forgot$/, /^\/reset\/[^/]+$/, /^\/invite\/[^/]+$/, /^\/share\/[^/]+$/];

export function proxy(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (password && !basicAuthOk(req.headers.get("authorization"), password))
    return new NextResponse("Password required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="NorthScale", charset="UTF-8"' },
    });

  const path = req.nextUrl.pathname;
  if (PUBLIC.some((r) => r.test(path)) || req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  if (path.startsWith("/api/")) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

function basicAuthOk(header: string | null, password: string) {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const i = decoded.indexOf(":");
    if (i < 0) return false;
    const userOk = !process.env.SITE_USER || safeEqual(decoded.slice(0, i), process.env.SITE_USER);
    return safeEqual(decoded.slice(i + 1), password) && userOk;
  } catch {
    return false;
  }
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!api/webhooks|api/inngest|_next/static|_next/image|favicon.ico).*)"],
};
