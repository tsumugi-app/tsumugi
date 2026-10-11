/**
 * Maintenance manifest: WHICH records may be synced to the Vault. IDs + the reviewed state only (updatedAt and a hash of the canonical
 * record). It never contains conversation or Memory text. It is chosen by the operator in the browser, validated here, never uploaded.
 */
export const MANIFEST_FORMAT = "tsumugi-maintenance-manifest";
export const MAX_MANIFEST_RECORDS = 20;
export interface ManifestRecord { kind: "conversation" | "memory"; id: string; expectedUpdatedAt: string; canonicalHash: string }
export interface MaintenanceManifest { format: typeof MANIFEST_FORMAT; schema: 1; scope: "vault-sync"; vaultId: string; records: ManifestRecord[] }
export type ManifestParse = { ok: true; manifest: MaintenanceManifest } | { ok: false; error: string };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Strict shape check. Errors are fixed codes (never echo the input). */
export function parseManifest(raw: string): ManifestParse {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, error: "not-json" }; }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: "not-object" };
  const m = json as Record<string, unknown>;
  if (m.format !== MANIFEST_FORMAT || m.schema !== 1 || m.scope !== "vault-sync") return { ok: false, error: "wrong-format" };
  if (!str(m.vaultId)) return { ok: false, error: "vaultId" };
  if (!Array.isArray(m.records) || m.records.length === 0) return { ok: false, error: "records-empty" };
  if (m.records.length > MAX_MANIFEST_RECORDS) return { ok: false, error: "too-many-records" };
  const seen = new Set<string>();
  for (const [i, r] of m.records.entries()) {
    if (typeof r !== "object" || r === null) return { ok: false, error: `records[${i}]` };
    const rec = r as Record<string, unknown>;
    if ((rec.kind !== "conversation" && rec.kind !== "memory") || !str(rec.id) || !str(rec.expectedUpdatedAt) || !/^[0-9a-f]{64}$/.test(String(rec.canonicalHash))) return { ok: false, error: `records[${i}]` };
    const key = `${rec.kind}:${rec.id}`;
    if (seen.has(key)) return { ok: false, error: `records[${i}]:duplicate` };
    seen.add(key);
  }
  return { ok: true, manifest: m as unknown as MaintenanceManifest };
}
