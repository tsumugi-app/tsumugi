/**
 * `idb`パッケージの最小限フェイク実装（テスト専用）。
 *
 * このプロジェクトのNode実行環境には`fake-indexeddb`のような外部パッケージも
 * 実IndexedDBも無いため（npm未接続）、`db.foundation.test.ts`が実際のdb.tsの
 * 新規transaction API（`putCanonicalRecordWithOutbox`系。Invariant 1/2）を検証
 * できるよう、`openDB`が返す最小限の互換オブジェクトをここで自前実装する。
 *
 * 忠実に再現する範囲：
 * - `db.transaction(storeNames, mode)`が返すtransactionは、staging（transaction
 *   ローカルの書き込み）を`tx.done`が解決するまで実ストアへ反映しない。
 * - transaction内のいずれかの`put`が失敗すると、transaction全体をabortし、
 *   staging中の書き込みは一切実ストアへ反映されない（＝IndexedDBの仕様通りの
 *   atomicity。ブラウザのIndexedDB実装固有の詳細ではなく、仕様で保証された挙動）。
 *
 * 本番コード（db.ts）はこのファイルを一切importしない。テストからのみ、
 * Module._loadで`require("idb")`をこのファイルへ差し替えて使う。
 */

type Key = string;

interface FakeStoreState {
  committed: Map<Key, unknown>;
  keyPath: string | undefined;
  indexKeyPath: Map<string, string>;
}

class FakeIDBDatabase {
  stores = new Map<string, FakeStoreState>();
  /** テスト専用：次の1回のtransactionだけ、このstore名への`put`を失敗させる（一発だけ有効）。 */
  failOnPutForNextTransaction = new Set<string>();
  /** テスト専用：次の1回の「単発put」（`db.put(storeName, ...)`、transaction経由ではない）だけを失敗させる（一発だけ有効）。 */
  failOnPlainPutOnce = new Set<string>();
  /** テスト専用：storeName→「次からN回目のput」（1-indexed）で失敗させる。それより前の呼び出しは成功する。 */
  failOnNthPlainPut = new Map<string, number>();
  createObjectStore(name: string, options?: { keyPath?: string }) {
    const store: FakeStoreState = { committed: new Map(), keyPath: options?.keyPath, indexKeyPath: new Map() };
    this.stores.set(name, store);
    return {
      createIndex: (indexName: string, keyPath: string) => {
        store.indexKeyPath.set(indexName, keyPath);
      },
    };
  }
}

function keyOf(store: FakeStoreState, value: unknown, explicitKey: Key | undefined): Key {
  if (explicitKey !== undefined) return explicitKey;
  if (store.keyPath) return (value as Record<string, unknown>)[store.keyPath] as Key;
  throw new Error("fakeIdb: key required (store has no keyPath)");
}

type StagedOp = { op: "put"; value: unknown } | { op: "delete" };

class FakeTransaction {
  private staging = new Map<string, Map<Key, StagedOp>>();
  private settled = false;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private donePromise: Promise<void>;

  constructor(
    private db: FakeIDBDatabase,
    storeNames: string[],
    private failOnPut: Set<string>
  ) {
    for (const name of storeNames) this.staging.set(name, new Map());
    this.donePromise = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  objectStore(name: string) {
    const staging = this.staging.get(name);
    if (!staging) throw new Error(`fakeIdb: store "${name}" not part of this transaction`);
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`fakeIdb: no such store "${name}"`);
    const failOnPut = this.failOnPut;
    const fail = (error: unknown) => this.fail(error);
    return {
      async get(key: Key) {
        const staged = staging.get(key);
        if (staged) return staged.op === "delete" ? undefined : staged.value;
        return store.committed.get(key);
      },
      async put(value: unknown, key?: Key) {
        if (failOnPut.has(name)) {
          const error = new Error(`fakeIdb: simulated put failure on store "${name}"`);
          fail(error);
          throw error;
        }
        const k = keyOf(store, value, key);
        staging.set(k, { op: "put", value });
        return k;
      },
      async delete(key: Key) {
        staging.set(key, { op: "delete" });
      },
    };
  }

  private fail(error: unknown) {
    if (this.settled) return;
    this.settled = true;
    this.rejectDone(error);
  }

  abort() {
    this.fail(new Error("fakeIdb: transaction aborted"));
  }

  get done(): Promise<void> {
    if (!this.settled) {
      this.settled = true;
      for (const [name, ops] of this.staging) {
        const store = this.db.stores.get(name)!;
        for (const [k, op] of ops) {
          if (op.op === "delete") store.committed.delete(k);
          else store.committed.set(k, op.value);
        }
      }
      this.resolveDone();
    }
    return this.donePromise;
  }
}

class FakeIDBPDatabase {
  constructor(private db: FakeIDBDatabase) {}

  async get(storeName: string, key: Key) {
    return this.db.stores.get(storeName)?.committed.get(key);
  }
  async put(storeName: string, value: unknown, key?: Key) {
    if (this.db.failOnPlainPutOnce.has(storeName)) {
      this.db.failOnPlainPutOnce.delete(storeName);
      throw new Error(`fakeIdb: simulated plain put failure on store "${storeName}"`);
    }
    const nth = this.db.failOnNthPlainPut.get(storeName);
    if (nth !== undefined) {
      if (nth <= 1) {
        this.db.failOnNthPlainPut.delete(storeName);
        throw new Error(`fakeIdb: simulated Nth put failure on store "${storeName}"`);
      }
      this.db.failOnNthPlainPut.set(storeName, nth - 1);
    }
    const store = this.db.stores.get(storeName)!;
    const k = keyOf(store, value, key);
    store.committed.set(k, value);
    return k;
  }
  async delete(storeName: string, key: Key) {
    this.db.stores.get(storeName)?.committed.delete(key);
  }
  async clear(storeName: string) {
    this.db.stores.get(storeName)?.committed.clear();
  }
  async getAll(storeName: string) {
    return [...(this.db.stores.get(storeName)?.committed.values() ?? [])];
  }
  async getAllFromIndex(storeName: string, indexName: string, query: unknown) {
    const store = this.db.stores.get(storeName)!;
    const kp = store.indexKeyPath.get(indexName);
    if (!kp) throw new Error(`fakeIdb: no such index "${indexName}" on "${storeName}"`);
    return [...store.committed.values()].filter((v) => (v as Record<string, unknown>)[kp] === query);
  }
  transaction(storeNames: string | string[], mode: "readonly" | "readwrite") {
    void mode; // フェイクではreadonly/readwriteを区別しない（テスト用途に十分なため）
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const failOnPut = this.db.failOnPutForNextTransaction;
    this.db.failOnPutForNextTransaction = new Set(); // 一発だけ有効（次のtransactionには持ち越さない）
    return new FakeTransaction(this.db, names, failOnPut);
  }
}

const namedFakeDatabases = new Map<string, FakeIDBDatabase>();
/** テスト専用：openDBを呼ぶ前に、同名DBの内部状態を完全にリセットする。 */
export function __resetFakeIdbDatabases(): void {
  namedFakeDatabases.clear();
}
/**
 * テスト専用：`openDB(name, ...)`で開いた（開かれる）データベースへ、次の1回のtransaction
 * だけ、指定store名への`put`を失敗させる予約をする。db.ts側の`getDB()`が返す実際の
 * connectionオブジェクトをテストから直接触れなくても使えるよう、DB名だけで指定する
 * （`namedFakeDatabases`は`openDB`と同じ名前空間を共有する）。
 */
export function __failNextPutOn(dbName: string, storeName: string): void {
  const fakeDb = getOrCreateNamedFakeDb(dbName);
  fakeDb.failOnPutForNextTransaction.add(storeName);
}
/** テスト専用：`db.put(storeName, ...)`（transactionを介さない単発put）を次の1回だけ失敗させる。 */
export function __failNextPlainPutOn(dbName: string, storeName: string): void {
  const fakeDb = getOrCreateNamedFakeDb(dbName);
  fakeDb.failOnPlainPutOnce.add(storeName);
}
/** テスト専用：`db.put(storeName, ...)`の、これから数えてN回目（1-indexed）の呼び出しだけを失敗させる。 */
export function __failOnNthPlainPut(dbName: string, storeName: string, n: number): void {
  const fakeDb = getOrCreateNamedFakeDb(dbName);
  fakeDb.failOnNthPlainPut.set(storeName, n);
}
function getOrCreateNamedFakeDb(dbName: string): FakeIDBDatabase {
  let fakeDb = namedFakeDatabases.get(dbName);
  if (!fakeDb) {
    fakeDb = new FakeIDBDatabase();
    namedFakeDatabases.set(dbName, fakeDb);
  }
  return fakeDb;
}

export async function openDB(
  name: string,
  version: number,
  options?: { upgrade?: (db: FakeIDBDatabase, oldVersion: number) => void }
): Promise<FakeIDBPDatabase> {
  let fakeDb = namedFakeDatabases.get(name);
  const isNew = !fakeDb;
  if (!fakeDb) {
    fakeDb = new FakeIDBDatabase();
    namedFakeDatabases.set(name, fakeDb);
  }
  if (isNew && options?.upgrade) options.upgrade(fakeDb, 0);
  return new FakeIDBPDatabase(fakeDb);
}
