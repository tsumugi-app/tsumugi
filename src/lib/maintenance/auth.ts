/**
 * Access decision for the maintenance area (`/maintenance/*`). Pure and runtime-agnostic: `src/proxy.ts` (Next.js proxy) and the
 * server-side page gate both call it, and it is unit-tested without Next.js.
 *
 * Rules (all must hold, otherwise access is refused):
 *  1. `MAINTENANCE_ENABLED` must be exactly "1". When the feature is disabled the area answers 404 EVEN to a correctly authenticated
 *     request (the credentials are not even looked at).
 *  2. `MAINTENANCE_BASIC_PASSWORD` must be set (non-empty). When it is not set the area answers 404 to everybody: there is no default
 *     password and no way to "log in" to an unconfigured deployment.
 *  3. The request must carry HTTP Basic credentials equal to `MAINTENANCE_BASIC_USER` (default "maintenance") and the password.
 *     The comparison is constant-time. Anything else is a 401 with a Basic challenge.
 * The credentials are server-side environment variables only: they are never sent to client code, never logged, never echoed.
 */
export interface MaintenanceAccessInput {
  enabled: string | undefined;
  user: string | undefined;
  password: string | undefined;
  authorization: string | null;
}
export type MaintenanceAccessDecision =
  | { action: "allow" }
  | { action: "not-found"; reason: "disabled" | "not-configured" }
  | { action: "challenge" };

const DEFAULT_USER = "maintenance";

/** Constant-time string comparison (length is compared too, without early exit on content). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Parses `Authorization: Basic base64(user:password)`. Returns null for anything that is not a well-formed Basic header. */
export function parseBasicAuthorization(header: string | null): { user: string; password: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/.exec(header);
  if (!m) return null;
  let decoded: string;
  try {
    const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

export function decideMaintenanceAccess(input: MaintenanceAccessInput): MaintenanceAccessDecision {
  if (input.enabled !== "1") return { action: "not-found", reason: "disabled" };
  if (typeof input.password !== "string" || input.password.length === 0) return { action: "not-found", reason: "not-configured" };
  const given = parseBasicAuthorization(input.authorization);
  if (!given) return { action: "challenge" };
  const userOk = safeEqual(given.user, input.user && input.user.length > 0 ? input.user : DEFAULT_USER);
  const passOk = safeEqual(given.password, input.password);
  return userOk && passOk ? { action: "allow" } : { action: "challenge" };
}

/** True for the paths this area owns. Used by the proxy (defence in depth on top of the matcher; `_next/data` always reaches the proxy). */
export function isMaintenancePath(pathname: string): boolean {
  return pathname === "/maintenance" || pathname.startsWith("/maintenance/") || /^\/_next\/data\/[^/]+\/maintenance(\/|\.json|$)/.test(pathname);
}

/** Reads the server-side configuration. Only call from server code (proxy / server components). */
export function maintenanceEnv(env: Record<string, string | undefined> = process.env): Pick<MaintenanceAccessInput, "enabled" | "user" | "password"> {
  return { enabled: env.MAINTENANCE_ENABLED, user: env.MAINTENANCE_BASIC_USER, password: env.MAINTENANCE_BASIC_PASSWORD };
}
