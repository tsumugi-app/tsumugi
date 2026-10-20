import type { Metadata } from "next";
import { notFound } from "next/navigation";
import MemoryRepairPrecheck from "@/components/MemoryRepairPrecheck";

/**
 * Developer-only READ-ONLY pre-flight page. Off by default: it exists only in a build made with
 * NEXT_PUBLIC_MEMORY_REPAIR_PRECHECK=1; every other build answers 404. Not linked from any screen, not indexed.
 * It does not mount Home / WipeGate / ChatScreen, so no startup flush, Capture, Connect or Recovery runs here.
 */
export const metadata: Metadata = { title: "Memory repair pre-flight", robots: { index: false, follow: false } };

export default function MemoryRepairPrecheckPage() {
  if (process.env.NEXT_PUBLIC_MEMORY_REPAIR_PRECHECK !== "1") notFound();
  return <MemoryRepairPrecheck />;
}
