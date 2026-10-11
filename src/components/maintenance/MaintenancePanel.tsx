"use client";

import { useRef, useState } from "react";
import { parseManifest, type MaintenanceManifest } from "@/lib/maintenance/manifest";
import { initMaintenanceSession, requestWritePermission, type SessionResult } from "@/lib/maintenance/session";
import {
  buildManifestDraft, diagnoseTargets, dryRun, executeSync, exportRecordBackup, inspectStates, preflight, verifyRecordBackup, verifyVaultBackup,
  type BackupVerification, type DiagnosisItem, type DryRunReport, type ExecuteReport, type Preflight, type TargetState,
} from "@/lib/maintenance/scopedVaultSync";

/**
 * Maintenance panel: S1 preflight, S2 dry run (+ non-target invariants), S3 execute + verify, for already-repaired records.
 * Nothing runs on load. No AI / Capture / Connect / network code is imported anywhere in this module graph (checked by a test).
 * It prints IDs (last 6 chars), states and file paths only, never conversation or Memory text.
 */
const tail = (id: string) => "…" + id.slice(-6);
type Step = "idle" | "busy";

export default function MaintenancePanel() {
  const [step, setStep] = useState<Step>("idle");
  const [manifest, setManifest] = useState<MaintenanceManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResult | null>(null);
  const [pf, setPf] = useState<Preflight | null>(null);
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [vaultBackup, setVaultBackup] = useState<BackupVerification | null>(null);
  const [recordBackup, setRecordBackup] = useState<BackupVerification | null>(null);
  const [exported, setExported] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<ExecuteReport | null>(null);
  const [states, setStates] = useState<TargetState[] | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisItem[] | null>(null);
  const [draftIds, setDraftIds] = useState("");
  const [draftText, setDraftText] = useState<string | null>(null);
  const vaultHandle = session && session.status === "ready" ? session.handle : null;
  const locked = useRef(false);

  async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (locked.current) return undefined;
    locked.current = true; setStep("busy"); setError(null);
    try { return await fn(); } catch (e) { setError("failed: " + ((e as Error)?.name ?? "error")); return undefined; } finally { locked.current = false; setStep("idle"); }
  }
  const reset = () => { setPf(null); setReport(null); setVaultBackup(null); setRecordBackup(null); setExported(false); setConfirm(""); setResult(null); setStates(null); setDiagnosis(null); };

  function loadManifest(file: File | undefined) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result ?? ""); const p = parseManifest(text); reset();
      if (p.ok) { setManifest(p.manifest); setError(null); } else { setManifest(null); setError("manifest rejected: " + p.error); }
    };
    r.readAsText(file);
  }
  const download = (name: string, text: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };

  async function startSession() { await guarded(async () => { setSession(await initMaintenanceSession()); }); }
  async function runPreflight() { if (!manifest || !vaultHandle) return; await guarded(async () => { reset(); setPf(await preflight(manifest, vaultHandle)); }); }
  async function runDry() { if (!manifest || !vaultHandle) return; await guarded(async () => { setVaultBackup(null); setRecordBackup(null); setExported(false); setResult(null); setReport(await dryRun(manifest, vaultHandle)); }); }
  async function pickVaultBackup() {
    if (!report || !vaultHandle) return;
    await guarded(async () => {
      const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) { setError("this browser cannot select a folder"); return; }
      const dir = await picker({ mode: "read" });
      setVaultBackup(await verifyVaultBackup(dir, vaultHandle, report));
    });
  }
  async function exportBackup() { if (!report) return; await guarded(async () => { download("tsumugi-maintenance-record-backup.json", await exportRecordBackup(report)); setExported(true); }); }
  function loadRecordBackup(file: File | undefined) {
    if (!file || !report) return;
    const r = new FileReader();
    r.onload = async () => { await guarded(async () => { setRecordBackup(await verifyRecordBackup(String(r.result ?? ""), report)); }); };
    r.readAsText(file);
  }
  async function grantWrite() { if (!vaultHandle) return; await guarded(async () => { await requestWritePermission(vaultHandle); setSession(await initMaintenanceSession()); }); }
  async function runExecute() {
    if (!manifest || !vaultHandle || !report) return;
    await guarded(async () => { setResult(await executeSync({ manifest, root: vaultHandle, report, vaultBackup, recordBackup, confirm })); });
  }
  async function runVerify() { if (!manifest || !vaultHandle) return; await guarded(async () => { setStates(await inspectStates(manifest, vaultHandle)); setDiagnosis(await diagnoseTargets(manifest, vaultHandle)); }); }
  async function makeDraft() {
    await guarded(async () => {
      const ids = draftIds.split(/[\s,]+/).filter(Boolean).map((s) => { const [kind, id] = s.split(":"); return { kind: kind as "conversation" | "memory", id }; });
      const draft = await buildManifestDraft(ids); const text = JSON.stringify(draft, null, 2); setDraftText(text); download("tsumugi-maintenance-manifest-draft.json", text);
    });
  }

  const busy = step === "busy";
  const canExecute = !!report?.ok && !!vaultBackup?.ok && !!recordBackup?.ok && report && confirm === `SYNC ${report.preflight.targets.length}`;
  const Row = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => <li className={ok ? "text-emerald-700" : "text-red-700"}>{ok ? "PASS" : "FAIL"} {children}</li>;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 text-sm">
      <h1 className="text-lg font-medium">Tsumugi maintenance: Vault sync of repaired records</h1>
      <p className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600">
        Runs on this origin only. It never calls an AI API, Capture or Connect. Only the records listed in the manifest can be synced. The result lists IDs and states, not text.
      </p>
      {error && <p className="text-red-700">{error}</p>}

      <section className="flex flex-col gap-2"><h2 className="font-medium">0. Manifest</h2>
        <input type="file" accept=".json,application/json" onChange={(e) => loadManifest(e.target.files?.[0])} />
        {manifest && <p>manifest: {manifest.records.length} record(s), scope {manifest.scope}</p>}
        <details><summary>create a manifest draft from record ids (kind:id, space separated)</summary>
          <textarea className="w-full border p-1" value={draftIds} onChange={(e) => setDraftIds(e.target.value)} rows={3} />
          <button disabled={busy || !draftIds.trim()} onClick={() => void makeDraft()} className="border px-3 py-1">Download draft (review it, then load it above)</button>
          {draftText && <p>draft downloaded</p>}
        </details>
      </section>

      <section className="flex flex-col gap-2"><h2 className="font-medium">1. Session and preflight (read-only)</h2>
        <button disabled={busy} onClick={() => void startSession()} className="border px-3 py-1">Find the Vault folder</button>
        {session && <p>session: {session.status}{session.status === "ready" ? ` read=${session.readPermission} write=${session.writePermission}` : ` (${session.detail})`}</p>}
        <button disabled={busy || !manifest || !vaultHandle} onClick={() => void runPreflight()} className="border px-3 py-1">Run preflight</button>
        {pf && <ul>{pf.checks.map((c, i) => <Row key={i} ok={c.pass}>{c.code}{c.detail ? ` - ${c.detail}` : ""}</Row>)}</ul>}
      </section>

      <section className="flex flex-col gap-2"><h2 className="font-medium">2. Dry run (shadow copy; writes nothing)</h2>
        <button disabled={busy || !manifest || !vaultHandle} onClick={() => void runDry()} className="border px-3 py-1">Run dry run</button>
        {report && (<div>
          <p className={report.ok ? "text-emerald-700" : "text-red-700"}>{report.ok ? "CLEAN: no non-target change, writers and projection succeed" : "NOT CLEAN: execution is blocked"}</p>
          {!report.preflight.ok && <ul>{report.preflight.checks.filter((c) => !c.pass).map((c, i) => <Row key={i} ok={false}>{c.code}</Row>)}</ul>}
          <ul>{report.writers.map((w, i) => <li key={i}>writer {w.kind} {tail(w.id)}: {w.status}{w.reason ? ` (${w.reason})` : ""}</li>)}</ul>
          <ul>{report.projection.map((p, i) => <li key={i}>projection {p.kind} {tail(p.id)}: {p.status}{p.reason ? ` (${p.reason})` : ""}</li>)}</ul>
          <p>files that would change ({report.files.length}):</p>
          <ul>{report.files.map((f) => <li key={f.path}>{f.before === null ? "CREATE" : "MODIFY"} {f.path}</li>)}</ul>
          {report.violations.length > 0 && <><p className="text-red-700">violations ({report.violations.length}):</p><ul>{report.violations.map((v, i) => <li key={i} className="text-red-700">{v.code} {v.path} {v.detail}</li>)}</ul></>}
          {report.warnings.map((w, i) => <p key={i} className="text-amber-700">warning: {w}</p>)}
          <p className="text-xs">fingerprint {report.fingerprint.slice(0, 16)}…</p>
        </div>)}
      </section>

      <section className="flex flex-col gap-2"><h2 className="font-medium">3. Backups (verified by the app)</h2>
        <p className="text-xs">Select the folder that holds your copy of the Vault: every file this sync will modify must be byte-identical there. Then export the record backup and load it back.</p>
        <button disabled={busy || !report?.ok} onClick={() => void pickVaultBackup()} className="border px-3 py-1">Select Vault backup folder</button>
        {vaultBackup && <p className={vaultBackup.ok ? "text-emerald-700" : "text-red-700"}>vault backup: {vaultBackup.ok ? "verified" : vaultBackup.problems.join(", ")}</p>}
        <button disabled={busy || !report?.ok} onClick={() => void exportBackup()} className="border px-3 py-1">Export record backup (download)</button>
        <input type="file" accept=".json,application/json" disabled={!exported} onChange={(e) => loadRecordBackup(e.target.files?.[0])} />
        {recordBackup && <p className={recordBackup.ok ? "text-emerald-700" : "text-red-700"}>record backup: {recordBackup.ok ? "verified" : recordBackup.problems.join(", ")}</p>}
      </section>

      <section className="flex flex-col gap-2"><h2 className="font-medium">4. Execute</h2>
        <button disabled={busy || !vaultHandle} onClick={() => void grantWrite()} className="border px-3 py-1">Grant Vault write access</button>
        <input className="border px-2 py-1" placeholder={report ? `SYNC ${report.preflight.targets.length}` : "SYNC <n>"} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button disabled={busy || !canExecute} onClick={() => void runExecute()} className="border border-red-700 px-3 py-1">Execute sync</button>
        {result && (<div>
          <p className={result.ok ? "text-emerald-700" : "text-red-700"}>{result.ok ? "SYNC COMPLETE and verified" : result.refused ? `REFUSED: ${result.refused}` : `STOPPED at ${result.stoppedAt ?? "verification"}`}</p>
          <ul>{result.steps.map((s, i) => <li key={i}>{s.kind} {tail(s.id)}: writer={s.writer} projection={s.projection}</li>)}</ul>
          <p>predicted vs actual differences: {result.verification.predictedVsActual.length}; invariant violations: {result.verification.invariantViolations.length}; IndexedDB collateral: {result.verification.idbCollateral.length}; canonical changed: {result.verification.canonicalChanged.length}</p>
          <p>unplanned writes blocked: {result.verification.blockedWrites.length}; unexpected files created/changed/deleted: {result.verification.unexpectedCreated.length}/{result.verification.unexpectedChanged.length}/{result.verification.unexpectedDeleted.length}</p>
          {[...result.verification.blockedWrites, ...result.verification.unexpectedCreated.map((p) => "created " + p), ...result.verification.unexpectedChanged.map((p) => "changed " + p), ...result.verification.unexpectedDeleted.map((p) => "deleted " + p), ...result.verification.predictedVsActual].map((x, i) => <p key={i} className="text-red-700">{x}</p>)}
          <p>files:</p>
          <ul>{result.fileProgress.map((f) => <li key={f.path} className={f.state === "written-as-planned" ? "text-emerald-700" : "text-red-700"}>{f.state} {f.path}</li>)}</ul>
          {result.diagnosis.some((d) => d.status !== "ok") && <><p>items that do not match (no automatic repair):</p><ul>{result.diagnosis.filter((d) => d.status !== "ok").map((d, i) => <li key={i} className="text-red-700">{d.kind} {tail(d.id)} {d.area}: {d.item} = {d.status}{d.detail ? ` (${d.detail})` : ""}</li>)}</ul></>}
        </div>)}
      </section>

      <section className="flex flex-col gap-2"><h2 className="font-medium">5. Current state (read-only; shows a half-finished sync)</h2>
        <button disabled={busy || !manifest || !vaultHandle} onClick={() => void runVerify()} className="border px-3 py-1">Inspect</button>
        {diagnosis && <ul>{diagnosis.map((d, i) => <li key={i} className={d.status === "ok" ? "text-emerald-700" : d.status === "legacy-format" ? "text-amber-700" : "text-red-700"}>{d.kind} {tail(d.id)} {d.area}: {d.item} = {d.status}{d.detail ? ` (${d.detail})` : ""}</li>)}</ul>}
        {(states ?? result?.states) && <ul>{(states ?? result?.states ?? []).map((s, i) => <li key={i}>{s.kind} {tail(s.id)}: vault={String(s.vaultMatchesCanonical)} ledgerSynced={String(s.ledgerSynced)} outbox={s.outbox}</li>)}</ul>}
      </section>
    </main>
  );
}
