import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decideMaintenanceAccess, isMaintenancePath, maintenanceEnv } from "@/lib/maintenance/auth";

/**
 * Protects ONLY `/maintenance/*` (Next.js 16 proxy). Every other path is excluded by the matcher and never reaches this function,
 * so normal pages, APIs, the PWA manifest and static assets are unaffected. See lib/maintenance/auth.ts for the rules.
 * (`/_next/data/...` requests always invoke the proxy; they are passed through unless they belong to the maintenance area.)
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isMaintenancePath(pathname)) return NextResponse.next();

  const decision = decideMaintenanceAccess({ ...maintenanceEnv(), authorization: request.headers.get("authorization") });
  if (decision.action === "allow") {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }
  if (decision.action === "challenge") {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="tsumugi-maintenance", charset="UTF-8"', "Cache-Control": "no-store" },
    });
  }
  // disabled / not configured: indistinguishable from a page that does not exist, even for authenticated requests
  return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

export const config = {
  matcher: ["/maintenance", "/maintenance/:path*"],
};
