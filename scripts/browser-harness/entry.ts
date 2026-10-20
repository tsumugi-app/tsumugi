// Real-browser smoke harness (not part of the app). Bundled by CI and loaded by hand into a normal browser tab to exercise the REAL Web Locks and
// IndexedDB behaviour of the maintenance window and the Vault-world lock with the production modules. Dummy data only; no network, no Vault folder.
import * as lock from "../../src/lib/vaultWorldLock";
import * as win from "../../src/lib/maintenance/maintenanceWindow";
import * as gate from "../../src/lib/maintenance/maintenanceGate";
import * as db from "../../src/lib/db";
import * as journal from "../../src/lib/vaultRecoveryJournal";

const NOW = new Date().toISOString();
async function prepare() {
  await db.putVaultIdentityRecord({ id: "current", vaultId: "harness-vault", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW } as never);
  await db.markVaultEpochCommitted(0);
  await db.markVaultWorldJournalMigrated();
  lock.setTabVaultEpoch(0);
}
(globalThis as unknown as { H: unknown }).H = { lock, win, gate, db, journal, prepare };
