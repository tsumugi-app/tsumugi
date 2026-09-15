/**
 * B2（軽量Registry index・多tab安全性設計）：ownership state machineの
 * table-driven test。
 *
 * このファイルはpackage.jsonのどのscript（dev/build/start/lint）からも
 * 呼ばれておらず、CIや`npm run`経由で自動実行される仕組みは現時点で存在
 * しない。このセッションではnode/npm/npxが利用不可のため、実際の実行は
 * 行っていない（全16ケースは実装コードとの手動突き合わせのみで検証した）。
 * 将来この環境でTS対応runner（tsx等）が使えるようになった場合の実行方法の
 * メモ：
 *   npx tsx src/lib/vaultRegistryOwnership.test.ts
 * プロジェクトへ将来テストランナー（vitest等）を導入した場合は、そちらの
 * conventionへ合わせて書き換えてよい。現時点ではこのプロジェクトにテスト
 * ランナーの依存関係が存在しないため（package.json確認済み）、Node組み込みの
 * `node:assert/strict`のみを使い、新規の外部依存を一切追加しない形にしている
 * （`node:test`は使わない——このプロジェクトにはテストランナーの実行経路が
 * 無いため、`run()`を素朴に呼ぶだけの自作の最小runnerにとどめている）。
 *
 * 対象は`decideVaultRegistryOwnershipStart`／
 * `checkVaultRegistryIndexPersistPreconditions`（いずれも純粋関数、Vault I/O
 * を一切行わない）のみ。実際のRegistry mutation経路・light check・UIには
 * まだ配線されていない（B3以降の対象）。
 *
 * レビュー指摘（Medium 1）を受けて、`decideVaultRegistryOwnershipStart`は
 * CLEANからのownership開始判定専用となった（`localState`を入力に取らない）。
 * そのため、旧テストにあった「OWNED_DIRTY/CONTESTED中はfreshMetaを無視して
 * 継続する」という2ケースは、この関数の責務外になったため削除した。
 */
import { strict as assert } from "node:assert";
import {
  VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE,
  checkVaultRegistryIndexPersistPreconditions,
  decideVaultRegistryOwnershipStart,
  type VaultRegistryGPreconditionInput,
  type VaultRegistryOwnershipStartAction,
  type VaultRegistryOwnershipStartInput,
} from "./vault";

const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "22222222-2222-4222-8222-222222222222";

interface StartCase {
  name: string;
  input: VaultRegistryOwnershipStartInput;
  expectedAction: VaultRegistryOwnershipStartAction;
  expectedRequiresMultipleMarkerWrite: boolean;
}

const startCases: StartCase[] = [
  {
    // 1: clean + baseline一致 → CLAIM
    name: "1: clean + baseline match -> CLAIM_OWNED_DIRTY",
    input: {
      myMirrorBaselineGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: null },
      diskIndex: { available: false },
    },
    expectedAction: "CLAIM_OWNED_DIRTY",
    expectedRequiresMultipleMarkerWrite: false,
  },
  {
    // 2: clean + baseline不一致 + fresh index → CATCH_UP
    name: "2: clean + stale baseline + fresh disk index -> INDEX_CATCH_UP_REQUIRED",
    input: {
      myMirrorBaselineGeneration: "G0",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: null },
      diskIndex: { available: true, builtAtGeneration: "G1" },
    },
    expectedAction: "INDEX_CATCH_UP_REQUIRED",
    expectedRequiresMultipleMarkerWrite: false,
  },
  {
    // 3: clean + baseline不一致 + index無し → CONTESTED
    name: "3: clean + stale baseline + no disk index -> BECOME_CONTESTED (requires write)",
    input: {
      myMirrorBaselineGeneration: "G0",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: null },
      diskIndex: { available: false },
    },
    expectedAction: "BECOME_CONTESTED",
    expectedRequiresMultipleMarkerWrite: true,
  },
  {
    // 3の追加バリエーション（最低限リストには無いが、index自体はあるが
    // generationが一致しないケースも同じくCONTESTEDになることを確認する）
    name: "3b (extra): clean + stale baseline + mismatched disk index -> BECOME_CONTESTED (requires write)",
    input: {
      myMirrorBaselineGeneration: "G0",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: null },
      diskIndex: { available: true, builtAtGeneration: "G0" },
    },
    expectedAction: "BECOME_CONTESTED",
    expectedRequiresMultipleMarkerWrite: true,
  },
  {
    // 4: other owner → CONTESTED
    name: "4: other instance already owner -> BECOME_CONTESTED (requires write)",
    input: {
      myMirrorBaselineGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: INSTANCE_B },
      diskIndex: { available: false },
    },
    expectedAction: "BECOME_CONTESTED",
    expectedRequiresMultipleMarkerWrite: true,
  },
  {
    // 5: MULTIPLE → CONTESTED（既に書かれているため再書き込み不要）
    name: "5: owner already MULTIPLE -> BECOME_CONTESTED (no write needed)",
    input: {
      myMirrorBaselineGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE },
      diskIndex: { available: false },
    },
    expectedAction: "BECOME_CONTESTED",
    expectedRequiresMultipleMarkerWrite: false,
  },
  {
    // 6: legacy generation無し owner=null → NOT_ESTABLISHED
    name: "6: legacy meta, registryGeneration undefined, owner=null -> GENERATION_NOT_ESTABLISHED",
    input: {
      myMirrorBaselineGeneration: undefined,
      freshMeta: { registryGeneration: undefined, dirtyOwnerInstanceId: null },
      diskIndex: { available: false },
    },
    expectedAction: "GENERATION_NOT_ESTABLISHED",
    expectedRequiresMultipleMarkerWrite: false,
  },
  {
    // 7: legacy generation無し owner=<instance> → NOT_ESTABLISHED
    // （この関数はmyInstanceIdを受け取らないため「self」と「other」を型レベルで
    // 区別できない。この関数にとってはどちらも「何らかの実instanceId文字列」で
    // あり、以下owner=INSTANCE_A/owner=INSTANCE_Bのいずれであっても分岐は
    // 変わらないことを示すため、6/7/8で異なる値を使い分けている）
    name: "7: legacy meta, registryGeneration undefined, owner=<some instance> -> GENERATION_NOT_ESTABLISHED",
    input: {
      myMirrorBaselineGeneration: undefined,
      freshMeta: { registryGeneration: undefined, dirtyOwnerInstanceId: INSTANCE_A },
      diskIndex: { available: false },
    },
    expectedAction: "GENERATION_NOT_ESTABLISHED",
    expectedRequiresMultipleMarkerWrite: false,
  },
  {
    // 8: legacy generation無し owner=other → NOT_ESTABLISHED
    name: "8: legacy meta, registryGeneration undefined, owner=other instance -> GENERATION_NOT_ESTABLISHED",
    input: {
      myMirrorBaselineGeneration: undefined,
      freshMeta: { registryGeneration: undefined, dirtyOwnerInstanceId: INSTANCE_B },
      diskIndex: { available: false },
    },
    expectedAction: "GENERATION_NOT_ESTABLISHED",
    expectedRequiresMultipleMarkerWrite: false,
  },
  {
    // 9: legacy generation無し owner=MULTIPLE → NOT_ESTABLISHED
    name: "9: legacy meta, registryGeneration undefined, owner=MULTIPLE -> GENERATION_NOT_ESTABLISHED",
    input: {
      myMirrorBaselineGeneration: undefined,
      freshMeta: { registryGeneration: undefined, dirtyOwnerInstanceId: VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE },
      diskIndex: { available: false },
    },
    expectedAction: "GENERATION_NOT_ESTABLISHED",
    expectedRequiresMultipleMarkerWrite: false,
  },
];

interface PreconditionCase {
  name: string;
  input: VaultRegistryGPreconditionInput;
  expectedCanPersist: boolean;
}

const preconditionCases: PreconditionCase[] = [
  {
    // 10: G正常条件 → canPersist true
    name: "10: normal owned+matching-generation conditions -> canPersist true",
    input: {
      localState: "OWNED_DIRTY",
      myInstanceId: INSTANCE_A,
      myOwnedGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: INSTANCE_A },
    },
    expectedCanPersist: true,
  },
  {
    // 11: G owner=other → false
    name: "11: meta owner is a different instance -> canPersist false",
    input: {
      localState: "OWNED_DIRTY",
      myInstanceId: INSTANCE_A,
      myOwnedGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: INSTANCE_B },
    },
    expectedCanPersist: false,
  },
  {
    // 12: G generation mismatch → false
    name: "12: meta.registryGeneration does not match myOwnedGeneration -> canPersist false",
    input: {
      localState: "OWNED_DIRTY",
      myInstanceId: INSTANCE_A,
      myOwnedGeneration: "G1",
      freshMeta: { registryGeneration: "G2", dirtyOwnerInstanceId: INSTANCE_A },
    },
    expectedCanPersist: false,
  },
  {
    // 13: G localState != OWNED_DIRTY → false
    name: "13: localState is not OWNED_DIRTY -> canPersist false",
    input: {
      localState: "CONTESTED",
      myInstanceId: INSTANCE_A,
      myOwnedGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: INSTANCE_A },
    },
    expectedCanPersist: false,
  },
  {
    // 14: G myInstanceId=MULTIPLE → false
    // （Medium 2で指摘された具体的な反例：myInstanceIdが誤ってsentinel値その
    // ものになっており、かつfreshMeta.dirtyOwnerInstanceIdも同じMULTIPLEで、
    // generationも一致している——単純な等値比較だけでは誤ってtrueになりうる
    // ケースを、明示的なMULTIPLE拒否で防ぐ）
    name: "14: myInstanceId itself is the MULTIPLE sentinel -> canPersist false (fail-closed)",
    input: {
      localState: "OWNED_DIRTY",
      myInstanceId: VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE,
      myOwnedGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE },
    },
    expectedCanPersist: false,
  },
  {
    // 15: G meta.owner=MULTIPLE → false
    name: "15: meta.dirtyOwnerInstanceId is MULTIPLE while myInstanceId is a normal id -> canPersist false",
    input: {
      localState: "OWNED_DIRTY",
      myInstanceId: INSTANCE_A,
      myOwnedGeneration: "G1",
      freshMeta: { registryGeneration: "G1", dirtyOwnerInstanceId: VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE },
    },
    expectedCanPersist: false,
  },
];

function run(): void {
  let failures = 0;

  for (const c of startCases) {
    const result = decideVaultRegistryOwnershipStart(c.input);
    try {
      assert.equal(result.action, c.expectedAction, `action mismatch for "${c.name}"`);
      assert.equal(
        result.requiresMultipleMarkerWrite,
        c.expectedRequiresMultipleMarkerWrite,
        `requiresMultipleMarkerWrite mismatch for "${c.name}"`
      );
      console.log(`ok - ${c.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL - ${c.name}:`, error);
    }
  }

  for (const c of preconditionCases) {
    const result = checkVaultRegistryIndexPersistPreconditions(c.input);
    try {
      assert.equal(result.canPersist, c.expectedCanPersist, `canPersist mismatch for "${c.name}"`);
      console.log(`ok - ${c.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL - ${c.name}:`, error);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} case(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${startCases.length + preconditionCases.length} cases passed.`);
  }
}

run();
