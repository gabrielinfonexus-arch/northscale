import { NextResponse, type NextRequest } from "next/server";

/**
 * Site-wide password gate (HTTP Basic auth) until real login arrives in phase 8.
 * - SITE_PASSWORD set → every page and API asks for it (user name: anything, or SITE_USER if set).
 * - Unset in production → the site refuses to serve, so a deploy is never left open by accident.
 * - Unset in development → no gate (local work and tests).
 * Webhooks and the Inngest endpoint are excluded: they verify their own signatures / keys.
 */
export function proxy(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === "production")
      return new NextResponse("NorthScale is not open yet: set SITE_PASSWORD in the server environment.", { status: 503 });
    return NextResponse.next();
  }
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const i = decoded.indexOf(":");
      const user = decoded.slice(0, i);
      const pass = decoded.slice(i + 1);
      const userOk = !process.env.SITE_USER || safeEqual(user, process.env.SITE_USER);
      if (i >= 0 && safeEqual(pass, password) && userOk) return NextResponse.next();
    } catch {
      // malformed header → ask again
    }
  }
  return new NextResponse("Password required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="NorthScale", charset="UTF-8"' },
  });
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
