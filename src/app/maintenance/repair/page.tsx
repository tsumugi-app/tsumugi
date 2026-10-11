import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import MaintenancePanel from "@/components/maintenance/MaintenancePanel";
import { decideMaintenanceAccess, maintenanceEnv } from "@/lib/maintenance/auth";

/**
 * Maintenance panel (Vault sync of already-repaired records). Not linked from any screen. It does not mount Home / WipeGate / ChatScreen,
 * so no startup flush, Capture, Connect or Recovery runs here. `src/proxy.ts` authenticates the request; this server component repeats
 * the decision (defence in depth) so that the page can never render when the area is disabled or unconfigured.
 */
export const metadata: Metadata = { title: "Tsumugi maintenance", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function MaintenanceRepairPage() {
  const h = await headers();
  const decision = decideMaintenanceAccess({ ...maintenanceEnv(), authorization: h.get("authorization") });
  if (decision.action !== "allow") notFound();
  return <MaintenancePanel />;
}
