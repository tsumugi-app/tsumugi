"use client";
/**
 * Memory Synthesis S1: the device's own Synthesis database (IndexedDB "tsumugi-synthesis"). Separate from the "tsumugi" database on purpose:
 * the Memory store, its schema upgrades, the Vault, the Outbox and sync never see it, and opening / clearing it can never touch them.
 *
 * Stores (schema version 1, recorded in every record and in the "meta" store, for a later export / device move):
 *   hypotheses  - Tsumugi's readings: a regenerable cache
 *   reactions   - the user's clear rejections / corrections: user data, removed only by "すべて初期化" or the full device wipe
 *   exposures   - conversations in which a hypothesis was used (provenance; kept like the reactions, so that an agreement captured there is never evidence)
 *   themeStates - per theme generation bookkeeping (regenerable)
 *   meta        - run bookkeeping, the schema record and the reset epoch
 * While the full device wipe is pending, nothing opens this database (the wipe deletes it; see dataWipe.ts).
 */
import { openDB, type IDBPDatabase } from "idb";
import { isWipePending, WipeInProgressError } from "./wipeState";
import {
  addExposure,
  mergeShown,
  removalOutcome,
  SYNTHESIS_DB_NAME,
  SYNTHESIS_SCHEMA_VERSION,
  type StoredHypothesis,
  type SynthesisChanges,
  type HypothesisExposure,
  type SynthesisRunMeta,
  type SynthesisState,
  type ThemeGenerationState,
  type UserReaction,
} from "./synthesisModel";
import { SynthesisResetError, type SynthesisStorePort } from "./synthesisRunner";

const DB_VERSION = 2;
const STORES = ["hypotheses", "reactions", "exposures", "themeStates", "meta"] as const;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getSynthesisDB(): Promise<IDBPDatabase> {
  if (isWipePending()) return Promise.reject(new WipeInProgressError());
  if (!dbPromise) {
    dbPromise = openDB(SYNTHESIS_DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("hypotheses")) db.createObjectStore("hypotheses", { keyPath: "id" });
        if (!db.objectStoreNames.contains("reactions")) db.createObjectStore("reactions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("exposures")) db.createObjectStore("exposures", { keyPath: "conversationId" });
        if (!db.objectStoreNames.contains("themeStates")) db.createObjectStore("themeStates", { keyPath: "themeId" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      },
      // another tab deleting / upgrading this database (the full wipe, "すべて初期化"): let it through
      blocking() {
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** clears the given stores and the run bookkeeping, and moves to a new epoch, in one transaction (an in-flight run then cannot write back) */
async function resetStores(names: ("hypotheses" | "reactions" | "exposures" | "themeStates")[]): Promise<void> {
  const db = await getSynthesisDB();
  const tx = db.transaction([...names, "meta"], "readwrite");
  for (const name of names) void tx.objectStore(name).clear();
  const meta = tx.objectStore("meta");
  const epoch = (await meta.get("epoch")) as { value?: string } | undefined;
  void meta.delete("run");
  void meta.put({ key: "epoch", value: String(Number(epoch?.value ?? "0") + 1) });
  await tx.done;
}

export const synthesisStore: SynthesisStorePort & {
  markShown(hypothesisIds: string[], conversationId: string, at: string): Promise<void>;
  clearCache(): Promise<void>;
  clearAll(): Promise<void>;
  counts(): Promise<{ hypotheses: number; activeHypotheses: number; reactions: number; lastSuccessAt?: string; lastResult?: string }>;
} = {
  async load(): Promise<SynthesisState> {
    const db = await getSynthesisDB();
    const tx = db.transaction([...STORES], "readonly");
    const [hypotheses, reactions, exposures, themeStates, meta] = await Promise.all([
      tx.objectStore("hypotheses").getAll() as Promise<StoredHypothesis[]>,
      tx.objectStore("reactions").getAll() as Promise<UserReaction[]>,
      tx.objectStore("exposures").getAll() as Promise<HypothesisExposure[]>,
      tx.objectStore("themeStates").getAll() as Promise<ThemeGenerationState[]>,
      tx.objectStore("meta").get("run") as Promise<SynthesisRunMeta | undefined>,
    ]);
    const epoch = (await tx.objectStore("meta").get("epoch")) as { value?: string } | undefined;
    await tx.done;
    return { hypotheses, reactions, exposures, themeStates, meta: meta ?? null, epoch: epoch?.value ?? "0" };
  },

  /** all changes of a run in ONE transaction: an interrupted run leaves the previous data as it was */
  async commit(changes: SynthesisChanges): Promise<void> {
    const db = await getSynthesisDB();
    const tx = db.transaction([...STORES], "readwrite");
    // a reset ("仮説を消す" / "すべて初期化", any tab) since the run started: write nothing (checked inside the same transaction)
    if (changes.expectedEpoch !== undefined) {
      const epoch = (await tx.objectStore("meta").get("epoch")) as { value?: string } | undefined;
      if ((epoch?.value ?? "0") !== changes.expectedEpoch) {
        tx.abort();
        await tx.done.catch(() => undefined);
        throw new SynthesisResetError();
      }
    }
    const hyp = tx.objectStore("hypotheses");
    for (const r of changes.removeHypotheses ?? []) {
      const stored = (await hyp.get(r.id)) as StoredHypothesis | undefined;
      if (!stored) continue;
      const outcome = removalOutcome(stored, r.checkedThrough);
      void (outcome === "delete" ? hyp.delete(r.id) : hyp.put(outcome));
    }
    // merge, never replace, the uses: a chat turn may have recorded a use while this run was waiting for the AI
    for (const h of changes.putHypotheses ?? []) {
      const stored = (await hyp.get(h.id)) as StoredHypothesis | undefined;
      void hyp.put(stored ? { ...h, shownIn: mergeShown(stored.shownIn, h.shownIn) } : h);
    }
    const reactions = tx.objectStore("reactions");
    // reactions are only added (add() never overwrites an existing one)
    for (const r of changes.addReactions ?? []) if ((await reactions.getKey(r.id)) === undefined) void reactions.add(r);
    for (const t of changes.putThemeStates ?? []) void tx.objectStore("themeStates").put(t);
    if (changes.meta) {
      void tx.objectStore("meta").put(changes.meta);
      void tx.objectStore("meta").put({ key: "schema", schemaVersion: SYNTHESIS_SCHEMA_VERSION });
    }
    await tx.done;
  },

  /** one IndexedDB readwrite transaction (serialized across tabs): two tabs ending a session together cannot both claim the day's attempt */
  async claimRun(at: string, minHours: number): Promise<boolean> {
    const db = await getSynthesisDB();
    const tx = db.transaction("meta", "readwrite");
    const meta = (await tx.store.get("run")) as SynthesisRunMeta | undefined;
    const last = meta?.lastAttemptAt ? Date.parse(meta.lastAttemptAt) : NaN;
    if (Number.isFinite(last) && Date.parse(at) - last < minHours * 3_600_000) {
      await tx.done;
      return false;
    }
    await tx.store.put({ ...(meta ?? { schemaVersion: SYNTHESIS_SCHEMA_VERSION, key: "run" }), lastAttemptAt: at });
    await tx.done;
    return true;
  },

  /** a chat turn used these hypotheses (so that the next run can see how the user answered) */
  async markShown(hypothesisIds: string[], conversationId: string, at: string): Promise<void> {
    if (hypothesisIds.length === 0) return;
    const db = await getSynthesisDB();
    const tx = db.transaction(["hypotheses", "exposures"], "readwrite");
    const hyp = tx.objectStore("hypotheses");
    const exp = tx.objectStore("exposures");
    for (const id of hypothesisIds) {
      const h = (await hyp.get(id)) as StoredHypothesis | undefined;
      if (!h) continue;
      void hyp.put({ ...h, shownIn: mergeShown(h.shownIn, [{ conversationId, at }]) });
      void exp.put(addExposure((await exp.get(conversationId)) as HypothesisExposure | undefined, conversationId, h.themeId, at));
    }
    await tx.done;
  },

  /** clears Tsumugi's hypotheses and the bookkeeping; the user's rejections / corrections and the record of where hypotheses were used stay */
  async clearCache(): Promise<void> {
    await resetStores(["hypotheses", "themeStates"]);
  },

  /** clears everything, the user's rejections / corrections included (explicit user action only). The full device wipe deletes the database itself. */
  async clearAll(): Promise<void> {
    await resetStores(["hypotheses", "reactions", "exposures", "themeStates"]);
  },

  async counts() {
    const state = await synthesisStore.load();
    return {
      hypotheses: state.hypotheses.length,
      activeHypotheses: state.hypotheses.filter((h) => h.status === "active").length,
      reactions: state.reactions.length,
      lastSuccessAt: state.meta?.lastSuccessAt,
      lastResult: state.meta?.lastResult,
    };
  },
};
