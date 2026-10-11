/** Stable JSON (sorted keys) and SHA-256, used for the maintenance manifest, the dry-run fingerprint and backup comparison. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v === undefined ? null : v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const hashRecord = (record: unknown) => sha256Hex(stableStringify(record));
