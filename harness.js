"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/lib/vaultWorldLock.ts
  var vaultWorldLock_exports = {};
  __export(vaultWorldLock_exports, {
    IncompleteVaultWorldError: () => IncompleteVaultWorldError,
    StaleVaultTabError: () => StaleVaultTabError,
    bumpActiveVaultEpoch: () => bumpActiveVaultEpoch,
    getActiveVaultEpoch: () => getActiveVaultEpoch,
    getCommittedVaultEpoch: () => getCommittedVaultEpoch,
    getTabVaultEpoch: () => getTabVaultEpoch,
    getVaultWorldJournalVersion: () => getVaultWorldJournalVersion,
    markVaultEpochCommitted: () => markVaultEpochCommitted,
    markVaultWorldJournalMigrated: () => markVaultWorldJournalMigrated,
    notifyVaultSwitched: () => notifyVaultSwitched,
    runVaultSwitchExclusive: () => runVaultSwitchExclusive,
    runVaultWorldExclusive: () => runVaultWorldExclusive,
    setTabVaultEpoch: () => setTabVaultEpoch,
    subscribeVaultSwitchNotifications: () => subscribeVaultSwitchNotifications,
    withStartupSharedLock: () => withStartupSharedLock,
    withVaultWorldRead: () => withVaultWorldRead
  });

  // src/lib/db.ts
  var db_exports = {};
  __export(db_exports, {
    addConversationIfAbsentAndMarkSynced: () => addConversationIfAbsentAndMarkSynced,
    addMemoryLinkDurably: () => addMemoryLinkDurably,
    addMemoryObjectIfAbsentAndMarkSynced: () => addMemoryObjectIfAbsentAndMarkSynced,
    addSourceIfAbsentAndMarkSynced: () => addSourceIfAbsentAndMarkSynced,
    bumpActiveVaultEpoch: () => bumpActiveVaultEpoch,
    bumpRegistryGenerationEpoch: () => bumpRegistryGenerationEpoch,
    claimConnectState: () => claimConnectState,
    clearApiKey: () => clearApiKey,
    clearMemoryData: () => clearMemoryData,
    clearVaultHandle: () => clearVaultHandle,
    clearVaultSyncState: () => clearVaultSyncState,
    commitMaintenanceRestore: () => commitMaintenanceRestore,
    commitMemoryLinkRestoration: () => commitMemoryLinkRestoration,
    commitMemoryRepairTransaction: () => commitMemoryRepairTransaction,
    deleteSource: () => deleteSource,
    deleteVaultOutboxEntry: () => deleteVaultOutboxEntry,
    deleteVaultSyncState: () => deleteVaultSyncState,
    getActiveVaultEpoch: () => getActiveVaultEpoch,
    getAllConversations: () => getAllConversations,
    getAllMemoryObjects: () => getAllMemoryObjects,
    getAllSources: () => getAllSources,
    getCommittedVaultEpoch: () => getCommittedVaultEpoch,
    getConnectStateRecords: () => getConnectStateRecords,
    getConversation: () => getConversation,
    getDoneVaultOutboxEntries: () => getDoneVaultOutboxEntries,
    getHeldVaultOutboxEntries: () => getHeldVaultOutboxEntries,
    getMemoryObject: () => getMemoryObject,
    getMigrationJournalEntry: () => getMigrationJournalEntry,
    getPendingMigrationJournalEntries: () => getPendingMigrationJournalEntries,
    getPendingVaultOutboxEntries: () => getPendingVaultOutboxEntries,
    getProjectionHeldReevaluationMarker: () => getProjectionHeldReevaluationMarker,
    getRecoveryCheckMarker: () => getRecoveryCheckMarker,
    getRecoveryCheckWorldKey: () => getRecoveryCheckWorldKey,
    getRegistryGenerationEpoch: () => getRegistryGenerationEpoch,
    getSource: () => getSource,
    getVaultIdentityRecord: () => getVaultIdentityRecord,
    getVaultOutboxEntry: () => getVaultOutboxEntry,
    getVaultSyncState: () => getVaultSyncState,
    getVaultWorldJournalVersion: () => getVaultWorldJournalVersion,
    hasAnyVaultSyncState: () => hasAnyVaultSyncState,
    importMissingRecordsIfAbsent: () => importMissingRecordsIfAbsent,
    isAndroidOpfsVaultInitialized: () => isAndroidOpfsVaultInitialized,
    loadApiKey: () => loadApiKey,
    loadChatProvider: () => loadChatProvider,
    loadLastPromptedMemoryIds: () => loadLastPromptedMemoryIds,
    loadVaultHandle: () => loadVaultHandle,
    markAndroidOpfsVaultInitialized: () => markAndroidOpfsVaultInitialized,
    markConnectStateDone: () => markConnectStateDone,
    markMemoryProjectionSynced: () => markMemoryProjectionSynced,
    markVaultEpochCommitted: () => markVaultEpochCommitted,
    markVaultWorldJournalMigrated: () => markVaultWorldJournalMigrated,
    memoryRepairExpectation: () => memoryRepairExpectation,
    memoryRepairScopeOk: () => memoryRepairScopeOk,
    putConversation: () => putConversation,
    putConversationAndMarkSynced: () => putConversationAndMarkSynced,
    putConversationWithOutbox: () => putConversationWithOutbox,
    putMemoryObject: () => putMemoryObject,
    putMemoryObjectAndMarkSynced: () => putMemoryObjectAndMarkSynced,
    putMemoryObjectWithOutbox: () => putMemoryObjectWithOutbox,
    putMemoryProjectionOutcome: () => putMemoryProjectionOutcome,
    putMigrationJournalEntry: () => putMigrationJournalEntry,
    putSourceWithOutbox: () => putSourceWithOutbox,
    putVaultIdentityRecord: () => putVaultIdentityRecord,
    putVaultOutboxEntry: () => putVaultOutboxEntry,
    readMemoryRepairSettings: () => readMemoryRepairSettings,
    readMemoryRepairStorage: () => readMemoryRepairStorage,
    readProductionMigrationStateRaw: () => readProductionMigrationStateRaw,
    readRecoveryJournalRaw: () => readRecoveryJournalRaw,
    releaseConnectState: () => releaseConnectState,
    saveApiKey: () => saveApiKey,
    saveChatProvider: () => saveChatProvider,
    saveLastPromptedMemoryIds: () => saveLastPromptedMemoryIds,
    saveSource: () => saveSource,
    saveSourceAndMarkSynced: () => saveSourceAndMarkSynced,
    saveVaultHandle: () => saveVaultHandle,
    setProjectionHeldReevaluationMarker: () => setProjectionHeldReevaluationMarker,
    setRecoveryCheckMarker: () => setRecoveryCheckMarker,
    setVaultSyncState: () => setVaultSyncState,
    updateMemoryRevisitPrompt: () => updateMemoryRevisitPrompt,
    writeProductionMigrationStateRaw: () => writeProductionMigrationStateRaw,
    writeRecoveryJournalRaw: () => writeRecoveryJournalRaw
  });

  // node_modules/idb/build/index.js
  var instanceOfAny = (object2, constructors) => constructors.some((c) => object2 instanceof c);
  var idbProxyableTypes;
  var cursorAdvanceMethods;
  function getIdbProxyableTypes() {
    return idbProxyableTypes || (idbProxyableTypes = [
      IDBDatabase,
      IDBObjectStore,
      IDBIndex,
      IDBCursor,
      IDBTransaction
    ]);
  }
  function getCursorAdvanceMethods() {
    return cursorAdvanceMethods || (cursorAdvanceMethods = [
      IDBCursor.prototype.advance,
      IDBCursor.prototype.continue,
      IDBCursor.prototype.continuePrimaryKey
    ]);
  }
  var transactionDoneMap = /* @__PURE__ */ new WeakMap();
  var transformCache = /* @__PURE__ */ new WeakMap();
  var reverseTransformCache = /* @__PURE__ */ new WeakMap();
  function promisifyRequest(request) {
    const promise = new Promise((resolve, reject) => {
      const unlisten = () => {
        request.removeEventListener("success", success);
        request.removeEventListener("error", error);
      };
      const success = () => {
        resolve(wrap(request.result));
        unlisten();
      };
      const error = () => {
        reject(request.error);
        unlisten();
      };
      request.addEventListener("success", success);
      request.addEventListener("error", error);
    });
    reverseTransformCache.set(promise, request);
    return promise;
  }
  function cacheDonePromiseForTransaction(tx) {
    if (transactionDoneMap.has(tx))
      return;
    const done = new Promise((resolve, reject) => {
      const unlisten = () => {
        tx.removeEventListener("complete", complete);
        tx.removeEventListener("error", error);
        tx.removeEventListener("abort", error);
      };
      const complete = () => {
        resolve();
        unlisten();
      };
      const error = () => {
        reject(tx.error || new DOMException("AbortError", "AbortError"));
        unlisten();
      };
      tx.addEventListener("complete", complete);
      tx.addEventListener("error", error);
      tx.addEventListener("abort", error);
    });
    transactionDoneMap.set(tx, done);
  }
  var idbProxyTraps = {
    get(target, prop, receiver) {
      if (target instanceof IDBTransaction) {
        if (prop === "done")
          return transactionDoneMap.get(target);
        if (prop === "store") {
          return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
        }
      }
      return wrap(target[prop]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
        return true;
      }
      return prop in target;
    }
  };
  function replaceTraps(callback) {
    idbProxyTraps = callback(idbProxyTraps);
  }
  function wrapFunction(func) {
    if (getCursorAdvanceMethods().includes(func)) {
      return function(...args) {
        func.apply(unwrap(this), args);
        return wrap(this.request);
      };
    }
    return function(...args) {
      return wrap(func.apply(unwrap(this), args));
    };
  }
  function transformCachableValue(value) {
    if (typeof value === "function")
      return wrapFunction(value);
    if (value instanceof IDBTransaction)
      cacheDonePromiseForTransaction(value);
    if (instanceOfAny(value, getIdbProxyableTypes()))
      return new Proxy(value, idbProxyTraps);
    return value;
  }
  function wrap(value) {
    if (value instanceof IDBRequest)
      return promisifyRequest(value);
    if (transformCache.has(value))
      return transformCache.get(value);
    const newValue = transformCachableValue(value);
    if (newValue !== value) {
      transformCache.set(value, newValue);
      reverseTransformCache.set(newValue, value);
    }
    return newValue;
  }
  var unwrap = (value) => reverseTransformCache.get(value);
  function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
    const request = indexedDB.open(name, version);
    const openPromise = wrap(request);
    if (upgrade) {
      request.addEventListener("upgradeneeded", (event) => {
        upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
      });
    }
    if (blocked) {
      request.addEventListener("blocked", (event) => blocked(
        // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
        event.oldVersion,
        event.newVersion,
        event
      ));
    }
    openPromise.then((db) => {
      if (terminated)
        db.addEventListener("close", () => terminated());
      if (blocking) {
        db.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
      }
    }).catch(() => {
    });
    return openPromise;
  }
  var readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
  var writeMethods = ["put", "add", "delete", "clear"];
  var cachedMethods = /* @__PURE__ */ new Map();
  function getMethod(target, prop) {
    if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
      return;
    }
    if (cachedMethods.get(prop))
      return cachedMethods.get(prop);
    const targetFuncName = prop.replace(/FromIndex$/, "");
    const useIndex = prop !== targetFuncName;
    const isWrite = writeMethods.includes(targetFuncName);
    if (
      // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
      !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
    ) {
      return;
    }
    const method = async function(storeName, ...args) {
      const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
      let target2 = tx.store;
      if (useIndex)
        target2 = target2.index(args.shift());
      return (await Promise.all([
        target2[targetFuncName](...args),
        isWrite && tx.done
      ]))[0];
    };
    cachedMethods.set(prop, method);
    return method;
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
    has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
  }));
  var advanceMethodProps = ["continue", "continuePrimaryKey", "advance"];
  var methodMap = {};
  var advanceResults = /* @__PURE__ */ new WeakMap();
  var ittrProxiedCursorToOriginalProxy = /* @__PURE__ */ new WeakMap();
  var cursorIteratorTraps = {
    get(target, prop) {
      if (!advanceMethodProps.includes(prop))
        return target[prop];
      let cachedFunc = methodMap[prop];
      if (!cachedFunc) {
        cachedFunc = methodMap[prop] = function(...args) {
          advanceResults.set(this, ittrProxiedCursorToOriginalProxy.get(this)[prop](...args));
        };
      }
      return cachedFunc;
    }
  };
  async function* iterate(...args) {
    let cursor = this;
    if (!(cursor instanceof IDBCursor)) {
      cursor = await cursor.openCursor(...args);
    }
    if (!cursor)
      return;
    cursor = cursor;
    const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
    ittrProxiedCursorToOriginalProxy.set(proxiedCursor, cursor);
    reverseTransformCache.set(proxiedCursor, unwrap(cursor));
    while (cursor) {
      yield proxiedCursor;
      cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
      advanceResults.delete(proxiedCursor);
    }
  }
  function isIteratorProp(target, prop) {
    return prop === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]) || prop === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]);
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get(target, prop, receiver) {
      if (isIteratorProp(target, prop))
        return iterate;
      return oldTraps.get(target, prop, receiver);
    },
    has(target, prop) {
      return isIteratorProp(target, prop) || oldTraps.has(target, prop);
    }
  }));

  // src/lib/debugTimingLog.ts
  var STORAGE_KEY = "tsumugi:debugTimingLog:v1";
  var MAX_ENTRIES = 300;
  var instanceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  function readEntries() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function writeEntries(entries) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
    }
  }
  function logTimingEvent(event, params = {}) {
    if (typeof window === "undefined") return;
    try {
      const entries = readEntries();
      entries.push({ ts: Date.now(), event, instanceId, ...params });
      while (entries.length > MAX_ENTRIES) entries.shift();
      writeEntries(entries);
    } catch {
    }
  }
  function hiddenFlag() {
    if (typeof document === "undefined") return 0;
    return document.hidden ? 1 : 0;
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    logTimingEvent("Debug page:load");
    document.addEventListener("visibilitychange", () => {
      logTimingEvent(document.hidden ? "Debug page:hidden" : "Debug page:visible");
    });
  }

  // src/lib/wipeState.ts
  var WIPE_MARKER_KEY = "tsumugi:wipe:v1";
  var WipeInProgressError = class extends Error {
    constructor(message = "\u3053\u306E\u7AEF\u672B\u306E\u30C7\u30FC\u30BF\u3092\u524A\u9664\u3057\u3066\u3044\u307E\u3059\u3002") {
      super(message);
      this.name = "WipeInProgressError";
    }
  };
  function isWipePending() {
    try {
      if (typeof localStorage === "undefined") return false;
      return localStorage.getItem(WIPE_MARKER_KEY) !== null;
    } catch {
      return false;
    }
  }

  // src/lib/eventTimeResolver.ts
  var EVENT_TIME_SOURCE_OFFSETS = {
    today: 0,
    yesterday: -1,
    "day-before-yesterday": -2,
    tomorrow: 1,
    "day-after-tomorrow": 2
  };
  var EVENT_TIME_SOURCES = [...Object.keys(EVENT_TIME_SOURCE_OFFSETS), "none"];

  // src/lib/profile.ts
  var SENSITIVE_PATTERN = new RegExp(
    [
      "\u75C5|\u75BE\u60A3|\u8A3A\u65AD|\u3046\u3064|\u9B31|\u969C\u5BB3|\u969C\u304C\u3044|\u764C|\u304C\u3093|\u670D\u85AC|\u6295\u85AC|\u51E6\u65B9|\u901A\u9662|\u5165\u9662|\u624B\u8853|\u6CBB\u7642|\u30EA\u30CF\u30D3\u30EA|\u598A\u5A20|\u4E0D\u598A|\u6D41\u7523|\u4F9D\u5B58|\u30A2\u30EB\u30B3\u30FC\u30EB|\u4E2D\u6BD2|\u81EA\u6BBA|\u6B7B\u306B\u305F\u3044|\u81EA\u50B7|\u8650\u5F85|\uFF24\uFF36|DV",
      "\u5B97\u6559|\u4FE1\u4EF0|\u4FE1\u8005|\u6559\u56E3|\u5275\u4FA1|\u7D71\u4E00\u6559\u4F1A|\u30AF\u30EA\u30B9\u30C1\u30E3\u30F3|\u4ECF\u6559\u5F92|\u30A4\u30B9\u30E9\u30E0|\u30E0\u30B9\u30EA\u30E0",
      "\u6027\u7684|\u30BB\u30AF\u30B7\u30E5\u30A2\u30EB|\u30B2\u30A4|\u30EC\u30BA\u30D3\u30A2\u30F3|\u30D0\u30A4\u30BB\u30AF\u30B7\u30E5\u30A2\u30EB|\u30C8\u30E9\u30F3\u30B9\u30B8\u30A7\u30F3\u30C0\u30FC|LGBT|\uFF2C\uFF27\uFF22\uFF34|\u540C\u6027\u611B|\u6027\u81EA\u8A8D",
      "\u5E74\u53CE|\u7D66\u6599|\u7D66\u4E0E|\u53CE\u5165|\u8CAF\u91D1|\u8CAF\u84C4|\u501F\u91D1|\u30ED\u30FC\u30F3|\u8CA0\u50B5|\u7834\u7523|\u8CC7\u7523|\u9810\u91D1|\u6295\u8CC7\u984D|\u751F\u6D3B\u4FDD\u8B77|\u6EDE\u7D0D|\u7A0E\u91D1",
      "\u902E\u6355|\u524D\u79D1|\u72AF\u7F6A|\u88C1\u5224|\u8A34\u8A1F|\u5211\u52D9\u6240|\u4FDD\u91C8",
      "\u653F\u6CBB|\u652F\u6301\u653F\u515A|\u6295\u7968|\u9078\u6319|\u81EA\u6C11|\u6C11\u4E3B\u515A|\u5171\u7523\u515A|\u516C\u660E|\u7DAD\u65B0|\u4EBA\u7A2E|\u6C11\u65CF|\u56FD\u7C4D|\u5728\u65E5|\u88AB\u5DEE\u5225|\u90E8\u843D",
      "\u96E2\u5A5A|\u5225\u5C45|\u4E0D\u502B|\u6D6E\u6C17|\u6B7B\u5225|\u4EA1\u304F\u306A|\u4ED6\u754C|\u4ECB\u8B77|\u8A8D\u77E5\u75C7|\u30D1\u30B9\u30EF\u30FC\u30C9|\u6697\u8A3C|\u30DE\u30A4\u30CA\u30F3\u30D0\u30FC|\u53E3\u5EA7|\u30AF\u30EC\u30B8\u30C3\u30C8"
    ].join("|")
  );

  // src/lib/markdown.ts
  function inferSourceType(source) {
    switch (source) {
      case "ai-capture":
        return "chat";
      case "system-generated":
        return "system";
      case "user-authored":
        return "manual";
      case "import":
        return "obsidian-import";
      default:
        return "chat";
    }
  }

  // src/lib/vaultOutbox.ts
  var PROJECTION_STEP_NAMES = ["markdown", "registry", "history", "index", "ledger"];
  function vaultOutboxIdFor(recordType, recordId) {
    return `${recordType}:${recordId}`;
  }
  function initialProjectionSteps() {
    const steps = {};
    for (const name of PROJECTION_STEP_NAMES) steps[name] = "pending";
    return steps;
  }
  function buildOutboxEntryForUpdate(existing, recordType, recordId, recordUpdatedAt, now) {
    if (existing && existing.recordUpdatedAt === recordUpdatedAt) {
      return { ...existing, updatedAt: now };
    }
    return {
      id: vaultOutboxIdFor(recordType, recordId),
      recordType,
      recordId,
      recordUpdatedAt,
      steps: initialProjectionSteps(),
      attempt: { count: 0, lastError: null, lastAttemptAt: null },
      status: "pending",
      heldReason: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
  }

  // src/lib/vaultIdentity.ts
  var VAULT_IDENTITY_RECORD_ID = "current";

  // src/lib/db.ts
  var dbPromise = null;
  function getDB() {
    if (isWipePending()) return Promise.reject(new WipeInProgressError());
    if (!dbPromise) {
      const openStart = Date.now();
      console.log(`[DB] open:start hidden=${hiddenFlag()}`);
      logTimingEvent("DB open:start", { hidden: hiddenFlag() });
      dbPromise = openDB("tsumugi", 6, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            const conversations = db.createObjectStore("conversations", {
              keyPath: "id"
            });
            conversations.createIndex("by-startedAt", "startedAt");
            const memoryObjects = db.createObjectStore("memoryObjects", {
              keyPath: "id"
            });
            memoryObjects.createIndex("by-date", "date");
            db.createObjectStore("handles");
          }
          if (oldVersion < 2) {
            db.createObjectStore("connectState");
          }
          if (oldVersion < 3) {
            db.createObjectStore("settings");
          }
          if (oldVersion < 4) {
            const sources = db.createObjectStore("sources", {
              keyPath: "id"
            });
            sources.createIndex("by-createdAt", "createdAt");
          }
          if (oldVersion < 5) {
            db.createObjectStore("vaultSyncState");
          }
          if (oldVersion < 6) {
            const outbox = db.createObjectStore("vaultOutbox", { keyPath: "id" });
            outbox.createIndex("by-status", "status");
            db.createObjectStore("vaultIdentity", { keyPath: "id" });
            const migrations = db.createObjectStore("migrationJournal", { keyPath: "id" });
            migrations.createIndex("by-status", "status");
          }
        },
        // 同一originの別接続（古いバージョンを開いたままの別タブ・ページインスタンス等）が
        // 存在し、このアップグレードが待たされている間に発火する。
        blocked() {
          const durationMs = Date.now() - openStart;
          console.log(`[DB] open:blocked hidden=${hiddenFlag()} durationMs=${durationMs}`);
          logTimingEvent("DB open:blocked", { hidden: hiddenFlag(), durationMs });
        },
        // 逆に、この接続（古いバージョン側）が新しいバージョンの接続をblockしている場合に
        // 発火する。ここでは何もクローズしない（回復処理はしない、計測のみ）。
        blocking() {
          const durationMs = Date.now() - openStart;
          console.log(`[DB] open:blocking hidden=${hiddenFlag()} durationMs=${durationMs}`);
          logTimingEvent("DB open:blocking", { hidden: hiddenFlag(), durationMs });
          if (isWipePending()) {
            const pending = dbPromise;
            dbPromise = null;
            void pending?.then((db) => db.close()).catch(() => void 0);
          }
        },
        terminated() {
          const durationMs = Date.now() - openStart;
          console.log(`[DB] open:terminated hidden=${hiddenFlag()} durationMs=${durationMs}`);
          logTimingEvent("DB open:terminated", { hidden: hiddenFlag(), durationMs });
        }
      });
      dbPromise.then(
        () => {
          const durationMs = Date.now() - openStart;
          console.log(`[DB] open:success hidden=${hiddenFlag()} durationMs=${durationMs}`);
          logTimingEvent("DB open:success", { hidden: hiddenFlag(), durationMs });
        },
        () => {
          const durationMs = Date.now() - openStart;
          console.log(`[DB] open:error hidden=${hiddenFlag()} durationMs=${durationMs}`);
          logTimingEvent("DB open:error", { hidden: hiddenFlag(), durationMs });
        }
      );
    }
    return dbPromise;
  }
  async function putConversation(conversation) {
    const db = await getDB();
    await db.put("conversations", conversation);
  }
  async function getConversation(id) {
    const db = await getDB();
    return db.get("conversations", id);
  }
  async function getAllConversations() {
    const db = await getDB();
    return db.getAll("conversations");
  }
  async function putMemoryObject(memoryObject) {
    const db = await getDB();
    await db.put("memoryObjects", memoryObject);
  }
  async function getAllMemoryObjects() {
    const db = await getDB();
    return db.getAll("memoryObjects");
  }
  async function getMemoryObject(id) {
    const db = await getDB();
    return db.get("memoryObjects", id);
  }
  async function saveSource(source) {
    const db = await getDB();
    await db.put("sources", source);
  }
  async function getSource(id) {
    const db = await getDB();
    return db.get("sources", id);
  }
  async function getAllSources() {
    const db = await getDB();
    return db.getAll("sources");
  }
  async function deleteSource(id) {
    const db = await getDB();
    await db.delete("sources", id);
  }
  async function abortAndSettleTransaction(tx, error) {
    try {
      tx.abort();
    } catch {
    }
    await tx.done.catch(() => {
    });
    throw error;
  }
  async function importMissingRecordsIfAbsent(candidates) {
    const db = await getDB();
    let insertedConversations = 0;
    let skippedConversations = 0;
    if (candidates.conversations.length > 0) {
      const tx = db.transaction("conversations", "readwrite");
      try {
        for (const conversation of candidates.conversations) {
          const existing = await tx.store.get(conversation.id);
          if (existing === void 0) {
            await tx.store.add(conversation);
            insertedConversations += 1;
          } else {
            skippedConversations += 1;
          }
        }
      } catch (error) {
        await abortAndSettleTransaction(tx, error);
      }
      await tx.done;
    }
    let insertedMemoryObjects = 0;
    let skippedMemoryObjects = 0;
    if (candidates.memoryObjects.length > 0) {
      const tx = db.transaction("memoryObjects", "readwrite");
      try {
        for (const memoryObject of candidates.memoryObjects) {
          const existing = await tx.store.get(memoryObject.id);
          if (existing === void 0) {
            await tx.store.add(memoryObject);
            insertedMemoryObjects += 1;
          } else {
            skippedMemoryObjects += 1;
          }
        }
      } catch (error) {
        await abortAndSettleTransaction(tx, error);
      }
      await tx.done;
    }
    let insertedSources = 0;
    let skippedSources = 0;
    if (candidates.sources.length > 0) {
      const tx = db.transaction("sources", "readwrite");
      try {
        for (const source of candidates.sources) {
          const existing = await tx.store.get(source.id);
          if (existing === void 0) {
            await tx.store.add(source);
            insertedSources += 1;
          } else {
            skippedSources += 1;
          }
        }
      } catch (error) {
        await abortAndSettleTransaction(tx, error);
      }
      await tx.done;
    }
    return {
      insertedConversations,
      insertedMemoryObjects,
      insertedSources,
      skippedConversations,
      skippedMemoryObjects,
      skippedSources
    };
  }
  async function clearMemoryData() {
    const db = await getDB();
    await Promise.all([
      db.clear("conversations"),
      db.clear("memoryObjects"),
      db.clear("sources"),
      db.clear("connectState"),
      db.clear("vaultSyncState")
    ]);
  }
  async function getVaultSyncState(key) {
    const db = await getDB();
    return db.get("vaultSyncState", key);
  }
  async function setVaultSyncState(key, updatedAt) {
    const db = await getDB();
    await db.put("vaultSyncState", updatedAt, key);
  }
  async function putConversationAndMarkSynced(conversation, syncKey) {
    const db = await getDB();
    const tx = db.transaction(["conversations", "vaultSyncState"], "readwrite");
    try {
      await tx.objectStore("conversations").put(conversation);
      await tx.objectStore("vaultSyncState").put(conversation.updatedAt, syncKey);
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }
  async function putMemoryObjectAndMarkSynced(memoryObject, syncKey) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "vaultSyncState"], "readwrite");
    try {
      await tx.objectStore("memoryObjects").put(memoryObject);
      await tx.objectStore("vaultSyncState").put(memoryObject.updatedAt, syncKey);
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }
  async function saveSourceAndMarkSynced(source, syncKey) {
    const db = await getDB();
    const tx = db.transaction(["sources", "vaultSyncState"], "readwrite");
    try {
      await tx.objectStore("sources").put(source);
      await tx.objectStore("vaultSyncState").put(source.updatedAt, syncKey);
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }
  async function addConversationIfAbsentAndMarkSynced(conversation, syncKey) {
    const db = await getDB();
    const tx = db.transaction(["conversations", "vaultSyncState"], "readwrite");
    let inserted = false;
    try {
      const store = tx.objectStore("conversations");
      const existing = await store.get(conversation.id);
      if (existing === void 0) {
        await store.add(conversation);
        await tx.objectStore("vaultSyncState").put(conversation.updatedAt, syncKey);
        inserted = true;
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return inserted;
  }
  async function addMemoryObjectIfAbsentAndMarkSynced(memoryObject, syncKey) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "vaultSyncState"], "readwrite");
    let inserted = false;
    try {
      const store = tx.objectStore("memoryObjects");
      const existing = await store.get(memoryObject.id);
      if (existing === void 0) {
        await store.add(memoryObject);
        await tx.objectStore("vaultSyncState").put(memoryObject.updatedAt, syncKey);
        inserted = true;
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return inserted;
  }
  async function addSourceIfAbsentAndMarkSynced(source, syncKey) {
    const db = await getDB();
    const tx = db.transaction(["sources", "vaultSyncState"], "readwrite");
    let inserted = false;
    try {
      const store = tx.objectStore("sources");
      const existing = await store.get(source.id);
      if (existing === void 0) {
        await store.add(source);
        await tx.objectStore("vaultSyncState").put(source.updatedAt, syncKey);
        inserted = true;
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return inserted;
  }
  async function getVaultOutboxEntry(id) {
    const db = await getDB();
    return db.get("vaultOutbox", id);
  }
  async function putVaultOutboxEntry(entry) {
    const db = await getDB();
    await db.put("vaultOutbox", entry);
  }
  async function getPendingVaultOutboxEntries() {
    const db = await getDB();
    return db.getAllFromIndex("vaultOutbox", "by-status", "pending");
  }
  async function getHeldVaultOutboxEntries() {
    const db = await getDB();
    return db.getAllFromIndex("vaultOutbox", "by-status", "held");
  }
  var projectionHeldReevaluationKey = (ruleVersion) => `projectionHeldReevaluated:${ruleVersion}`;
  async function getProjectionHeldReevaluationMarker(ruleVersion) {
    const db = await getDB();
    const raw = await db.get("settings", projectionHeldReevaluationKey(ruleVersion));
    return typeof raw === "string" ? raw : void 0;
  }
  async function setProjectionHeldReevaluationMarker(ruleVersion, at) {
    const db = await getDB();
    await db.put("settings", at, projectionHeldReevaluationKey(ruleVersion));
  }
  async function getDoneVaultOutboxEntries() {
    const db = await getDB();
    return db.getAllFromIndex("vaultOutbox", "by-status", "done");
  }
  async function deleteVaultOutboxEntry(id) {
    const db = await getDB();
    await db.delete("vaultOutbox", id);
  }
  async function getVaultIdentityRecord() {
    const db = await getDB();
    return db.get("vaultIdentity", VAULT_IDENTITY_RECORD_ID);
  }
  async function putVaultIdentityRecord(record) {
    const db = await getDB();
    await db.put("vaultIdentity", record);
  }
  async function getMigrationJournalEntry(id) {
    const db = await getDB();
    return db.get("migrationJournal", id);
  }
  async function putMigrationJournalEntry(entry) {
    const db = await getDB();
    await db.put("migrationJournal", entry);
  }
  async function getPendingMigrationJournalEntries() {
    const db = await getDB();
    return db.getAllFromIndex("migrationJournal", "by-status", "pending");
  }
  async function putCanonicalRecordWithOutboxInternal(storeName, recordType, record, now) {
    const db = await getDB();
    const outboxId = vaultOutboxIdFor(recordType, record.id);
    const tx = db.transaction([storeName, "vaultOutbox"], "readwrite");
    let entry;
    try {
      const outboxStore = tx.objectStore("vaultOutbox");
      const existing = await outboxStore.get(outboxId);
      entry = buildOutboxEntryForUpdate(existing, recordType, record.id, record.updatedAt, now);
      await Promise.all([tx.objectStore(storeName).put(record), outboxStore.put(entry)]);
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return entry;
  }
  async function putConversationWithOutbox(conversation, now = (/* @__PURE__ */ new Date()).toISOString()) {
    return putCanonicalRecordWithOutboxInternal("conversations", "conversation", conversation, now);
  }
  async function putMemoryObjectWithOutbox(memoryObject, recordType = "memory", now = (/* @__PURE__ */ new Date()).toISOString()) {
    return putCanonicalRecordWithOutboxInternal("memoryObjects", recordType, memoryObject, now);
  }
  async function putSourceWithOutbox(source, now = (/* @__PURE__ */ new Date()).toISOString()) {
    return putCanonicalRecordWithOutboxInternal("sources", "source", source, now);
  }
  async function hasAnyVaultSyncState() {
    const db = await getDB();
    const cursor = await db.transaction("vaultSyncState", "readonly").store.openKeyCursor();
    return cursor !== null;
  }
  async function deleteVaultSyncState(key) {
    const db = await getDB();
    await db.delete("vaultSyncState", key);
  }
  async function clearVaultSyncState() {
    const db = await getDB();
    await db.clear("vaultSyncState");
  }
  async function saveVaultHandle(handle) {
    const db = await getDB();
    await db.put("handles", handle, "vaultRoot");
  }
  async function loadVaultHandle() {
    const db = await getDB();
    return db.get("handles", "vaultRoot");
  }
  async function clearVaultHandle() {
    const db = await getDB();
    await db.delete("handles", "vaultRoot");
  }
  var API_KEY_STORAGE_KEY = {
    gemini: "geminiApiKey",
    openai: "openaiApiKey",
    claude: "claudeApiKey"
  };
  async function saveApiKey(apiKey, provider = "gemini") {
    const db = await getDB();
    await db.put("settings", apiKey, API_KEY_STORAGE_KEY[provider]);
  }
  async function loadApiKey(provider = "gemini") {
    const db = await getDB();
    return db.get("settings", API_KEY_STORAGE_KEY[provider]);
  }
  async function clearApiKey(provider = "gemini") {
    const db = await getDB();
    await db.delete("settings", API_KEY_STORAGE_KEY[provider]);
  }
  var CHAT_PROVIDER_KEY = "chatProvider";
  async function saveChatProvider(provider) {
    const db = await getDB();
    await db.put("settings", provider, CHAT_PROVIDER_KEY);
  }
  async function loadChatProvider() {
    const db = await getDB();
    const value = await db.get("settings", CHAT_PROVIDER_KEY);
    return value === "openai" || value === "claude" ? value : "gemini";
  }
  var ACTIVE_VAULT_EPOCH_KEY = "activeVaultEpoch";
  function isValidStoredEpochValue(raw) {
    if (typeof raw !== "string") return false;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && Number.isInteger(parsed) && Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === raw;
  }
  function parseStoredEpoch(raw) {
    if (raw === void 0) return { status: "missing" };
    if (!isValidStoredEpochValue(raw)) return { status: "invalid" };
    return { status: "valid", epoch: Number(raw) };
  }
  async function getActiveVaultEpoch() {
    const db = await getDB();
    const raw = await db.get("settings", ACTIVE_VAULT_EPOCH_KEY);
    const status = parseStoredEpoch(raw);
    if (status.status === "missing") return 0;
    if (status.status === "invalid") {
      throw new Error(`[Tsumugi] invalid activeVaultEpoch value in storage: ${JSON.stringify(raw)}`);
    }
    return status.epoch;
  }
  async function bumpActiveVaultEpoch(expectedEpoch) {
    const db = await getDB();
    const current = await getActiveVaultEpoch();
    if (current !== expectedEpoch) {
      throw new Error(
        `[Tsumugi] bumpActiveVaultEpoch: expected activeVaultEpoch=${expectedEpoch} but found ${current}; refusing (stale).`
      );
    }
    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new Error(`[Tsumugi] bumpActiveVaultEpoch: epoch overflow (current=${current})`);
    }
    await db.put("settings", String(next), ACTIVE_VAULT_EPOCH_KEY);
    return next;
  }
  var COMMITTED_VAULT_EPOCH_KEY = "committedVaultEpoch";
  async function getCommittedVaultEpoch() {
    const db = await getDB();
    const raw = await db.get("settings", COMMITTED_VAULT_EPOCH_KEY);
    return parseStoredEpoch(raw);
  }
  async function markVaultEpochCommitted(epoch) {
    const db = await getDB();
    await db.put("settings", String(epoch), COMMITTED_VAULT_EPOCH_KEY);
  }
  var REGISTRY_GENERATION_EPOCH_KEY = "registryGenerationEpoch";
  async function getRegistryGenerationEpoch() {
    const db = await getDB();
    const raw = await db.get("settings", REGISTRY_GENERATION_EPOCH_KEY);
    const status = parseStoredEpoch(raw);
    if (status.status === "missing") return 0;
    if (status.status === "invalid") {
      throw new Error(`[Tsumugi] invalid registryGenerationEpoch value in storage: ${JSON.stringify(raw)}`);
    }
    return status.epoch;
  }
  async function bumpRegistryGenerationEpoch(expectedEpoch) {
    const db = await getDB();
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    try {
      const raw = await store.get(REGISTRY_GENERATION_EPOCH_KEY);
      const status = parseStoredEpoch(raw);
      if (status.status === "invalid") {
        throw new Error(`[Tsumugi] invalid registryGenerationEpoch value in storage: ${JSON.stringify(raw)}`);
      }
      const current = status.status === "missing" ? 0 : status.epoch;
      if (current !== expectedEpoch) {
        throw new Error(
          `[Tsumugi] bumpRegistryGenerationEpoch: expected registryGenerationEpoch=${expectedEpoch} but found ${current}; refusing (stale).`
        );
      }
      const next = current + 1;
      if (!Number.isSafeInteger(next)) {
        throw new Error(`[Tsumugi] bumpRegistryGenerationEpoch: epoch overflow (current=${current})`);
      }
      await store.put(String(next), REGISTRY_GENERATION_EPOCH_KEY);
      await tx.done;
      return next;
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
      throw error;
    }
  }
  var VAULT_WORLD_JOURNAL_VERSION_KEY = "vaultWorldJournalVersion";
  var CURRENT_VAULT_WORLD_JOURNAL_VERSION = 1;
  async function getVaultWorldJournalVersion() {
    const db = await getDB();
    const raw = await db.get("settings", VAULT_WORLD_JOURNAL_VERSION_KEY);
    if (raw === void 0) return { status: "missing" };
    if (raw === String(CURRENT_VAULT_WORLD_JOURNAL_VERSION)) return { status: "current" };
    return { status: "unexpected", raw };
  }
  async function markVaultWorldJournalMigrated() {
    const db = await getDB();
    await db.put("settings", String(CURRENT_VAULT_WORLD_JOURNAL_VERSION), VAULT_WORLD_JOURNAL_VERSION_KEY);
  }
  var VAULT_RECOVERY_JOURNAL_KEY = "vaultRecoveryJournal";
  var recoveryCheckKey = (worldKey) => `recoveryCheck:${worldKey}`;
  async function getRecoveryCheckWorldKey() {
    const identity = await getVaultIdentityRecord();
    if (identity?.vaultId) return identity.vaultId;
    return `world:${await getActiveVaultEpoch()}`;
  }
  async function getRecoveryCheckMarker(vaultId) {
    const db = await getDB();
    const raw = await db.get("settings", recoveryCheckKey(vaultId));
    if (typeof raw !== "string") return void 0;
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && typeof value.build === "string" && typeof value.clean === "boolean" ? { build: value.build, clean: value.clean } : void 0;
    } catch {
      return void 0;
    }
  }
  async function setRecoveryCheckMarker(vaultId, marker) {
    const db = await getDB();
    await db.put("settings", JSON.stringify({ build: marker.build, clean: marker.clean }), recoveryCheckKey(vaultId));
  }
  async function readRecoveryJournalRaw() {
    const db = await getDB();
    const raw = await db.get("settings", VAULT_RECOVERY_JOURNAL_KEY);
    return typeof raw === "string" ? raw : void 0;
  }
  async function writeRecoveryJournalRaw(text) {
    const db = await getDB();
    await db.put("settings", text, VAULT_RECOVERY_JOURNAL_KEY);
  }
  var PRODUCTION_MIGRATION_STATE_KEY = "productionBootstrapMigration";
  async function readProductionMigrationStateRaw() {
    const db = await getDB();
    const raw = await db.get("settings", PRODUCTION_MIGRATION_STATE_KEY);
    return typeof raw === "string" ? raw : void 0;
  }
  async function writeProductionMigrationStateRaw(text) {
    const db = await getDB();
    await db.put("settings", text, PRODUCTION_MIGRATION_STATE_KEY);
  }
  var ANDROID_OPFS_VAULT_INITIALIZED_KEY = "androidOpfsVaultInitialized";
  async function isAndroidOpfsVaultInitialized() {
    const db = await getDB();
    const raw = await db.get("settings", ANDROID_OPFS_VAULT_INITIALIZED_KEY);
    return raw !== void 0;
  }
  async function markAndroidOpfsVaultInitialized() {
    const db = await getDB();
    await db.put("settings", "true", ANDROID_OPFS_VAULT_INITIALIZED_KEY);
  }
  var LAST_PROMPTED_MEMORY_IDS_KEY = "lastPromptedMemoryIds";
  var MAX_LAST_PROMPTED_MEMORY_IDS = 5;
  async function loadLastPromptedMemoryIds() {
    const db = await getDB();
    const raw = await db.get("settings", LAST_PROMPTED_MEMORY_IDS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  }
  async function saveLastPromptedMemoryIds(ids) {
    const db = await getDB();
    const trimmed = ids.slice(-MAX_LAST_PROMPTED_MEMORY_IDS);
    await db.put("settings", JSON.stringify(trimmed), LAST_PROMPTED_MEMORY_IDS_KEY);
  }
  async function claimConnectState(id, staleAfterMs) {
    const db = await getDB();
    const tx = db.transaction("connectState", "readwrite");
    const store = tx.objectStore("connectState");
    const existing = await store.get(id);
    let shouldClaim = true;
    if (existing) {
      if (existing.status === "done") {
        shouldClaim = false;
      } else {
        const age = Date.now() - new Date(existing.updatedAt).getTime();
        shouldClaim = age >= staleAfterMs;
      }
    }
    if (shouldClaim) {
      await store.put({ status: "in-progress", updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, id);
    }
    await tx.done;
    return shouldClaim;
  }
  async function markConnectStateDone(id) {
    const db = await getDB();
    await db.put("connectState", { status: "done", updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, id);
  }
  async function releaseConnectState(id) {
    const db = await getDB();
    await db.delete("connectState", id);
  }
  async function getConnectStateRecords() {
    const db = await getDB();
    const keys = await db.getAllKeys("connectState");
    const result = {};
    for (const key of keys) {
      const value = await db.get("connectState", key);
      if (value) result[key] = value;
    }
    return result;
  }
  async function updateMemoryRevisitPrompt(id, prompt) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects"], "readwrite");
    let result;
    try {
      const current = await tx.objectStore("memoryObjects").get(id);
      if (current) {
        result = current.revisitPrompt ? current : { ...current, revisitPrompt: prompt };
        if (!current.revisitPrompt) await tx.objectStore("memoryObjects").put(result);
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return result;
  }
  async function addMemoryLinkDurably(link) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "vaultOutbox"], "readwrite");
    const result = [];
    try {
      const memories = tx.objectStore("memoryObjects"), outbox = tx.objectStore("vaultOutbox");
      const a = await memories.get(link.sourceId), b = await memories.get(link.targetId);
      if (a && b && a.id !== b.id && [a, b].every((m) => !m.links.some((l) => l.sourceId === a.id && l.targetId === b.id || l.sourceId === b.id && l.targetId === a.id))) {
        for (const current of [a, b]) {
          const sameId = current.links.filter((l) => l.id === link.id);
          if (sameId.length > 1 || sameId.some((l) => JSON.stringify(l) !== JSON.stringify(link))) throw new Error("link-conflict");
          if (sameId.length) {
            result.push(current);
            continue;
          }
          const clock = Date.parse(current.updatedAt), now = Date.parse(link.createdAt);
          if (!Number.isFinite(clock) || !Number.isFinite(now)) throw new Error("link-time-invalid");
          const updated = { ...current, links: [...current.links, link], updatedAt: new Date(Math.max(clock + 1, now)).toISOString() };
          const type = current.metadata.source === "system-generated" ? "reflection" : "memory";
          const old = await outbox.get(vaultOutboxIdFor(type, current.id));
          await memories.put(updated);
          await outbox.put(buildOutboxEntryForUpdate(old, type, current.id, updated.updatedAt, link.createdAt));
          result.push(updated);
        }
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return result;
  }
  async function readMemoryRepairStorage(id) {
    const db = await getDB();
    const tx = db.transaction(["vaultOutbox", "vaultSyncState"], "readonly");
    const outbox = await tx.objectStore("vaultOutbox").get(vaultOutboxIdFor("memory", id));
    const ledger = await tx.objectStore("vaultSyncState").get(`memory:${id}`);
    await tx.done;
    return { outbox: outbox ?? null, ledger: ledger ?? null };
  }
  function memoryRepairExpectation(before, after, storage, now) {
    if (storage.ledger !== null && storage.ledger !== before.updatedAt && storage.ledger !== after.updatedAt) throw new Error("repair-ledger-changed");
    const old = storage.outbox;
    if (old && (old.id !== vaultOutboxIdFor("memory", before.id) || old.recordId !== before.id || old.recordType !== "memory" || old.recordUpdatedAt !== before.updatedAt && old.recordUpdatedAt !== after.updatedAt)) throw new Error("repair-outbox-changed");
    const pending = buildOutboxEntryForUpdate(void 0, "memory", after.id, after.updatedAt, now);
    const done = {
      ...pending,
      status: "done",
      heldReason: null,
      steps: { markdown: "done", registry: "done", index: "done", history: "done", ledger: "done" }
    };
    return { id: before.id, before: storage, intermediate: { outbox: pending, ledger: storage.ledger }, after: { outbox: done, ledger: after.updatedAt } };
  }
  async function putMemoryProjectionOutcome(entry) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "vaultOutbox"], "readwrite");
    try {
      const current = await tx.objectStore("memoryObjects").get(entry.recordId);
      const existing = await tx.objectStore("vaultOutbox").get(entry.id);
      if ((!current || current.updatedAt === entry.recordUpdatedAt) && (!existing || existing.recordUpdatedAt === entry.recordUpdatedAt)) await tx.objectStore("vaultOutbox").put(entry);
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }
  async function markMemoryProjectionSynced(recordType, id, version) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "vaultOutbox", "vaultSyncState"], "readwrite");
    let marked = false;
    try {
      const current = await tx.objectStore("memoryObjects").get(id);
      const outbox = await tx.objectStore("vaultOutbox").get(vaultOutboxIdFor(recordType, id));
      if (current?.updatedAt === version && outbox?.recordUpdatedAt === version && outbox.status === "done") {
        await tx.objectStore("vaultSyncState").put(version, `memory:${id}`);
        marked = true;
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return marked;
  }
  function memoryRepairScopeOk(before, after) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const base = { ...before, links: after.links, updatedAt: after.updatedAt };
    if (same(base, after)) return true;
    return before.metadata.sourceType === void 0 && after.metadata.sourceType === inferSourceType(before.metadata.source) && same({ ...base, metadata: { ...before.metadata, sourceType: after.metadata.sourceType } }, after);
  }
  async function commitMemoryLinkRestoration(changes, counterparts, now, finalize, expectations) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "vaultOutbox", "vaultSyncState"], "readwrite");
    try {
      const memories = tx.objectStore("memoryObjects"), outbox = tx.objectStore("vaultOutbox");
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      for (const c of counterparts) {
        const expected = changes.find((x) => x.before.id === c.id);
        const actual = await memories.get(c.id);
        if (!equal(actual, c) && !(expected && equal(actual, expected.after))) throw new Error("counterpart-changed");
      }
      if (expectations.length !== changes.length) throw new Error("repair-storage-missing");
      for (const { before, after } of changes) {
        if (!memoryRepairScopeOk(before, after)) throw new Error("repair-field-scope");
        const current = await memories.get(before.id);
        if (!equal(current, after) && (finalize || !equal(current, before))) throw new Error("canonical-changed");
        const id = vaultOutboxIdFor("memory", before.id);
        const expected = expectations.find((e) => e.id === before.id);
        if (!expected || !equal(expected, memoryRepairExpectation(before, after, expected.before, now))) throw new Error("repair-storage-invalid");
        const storage = { outbox: await outbox.get(id) ?? null, ledger: await tx.objectStore("vaultSyncState").get(`memory:${before.id}`) ?? null };
        const isBefore = equal(current, before) && equal(storage, expected.before);
        const isIntermediate = equal(current, after) && equal(storage, expected.intermediate);
        const isAfter = equal(current, after) && equal(storage, expected.after);
        if (!(isAfter || isIntermediate || !finalize && isBefore)) throw new Error("repair-storage-changed");
        if (isAfter) continue;
        if (!finalize) {
          await memories.put(after);
          await outbox.put(expected.intermediate.outbox);
        } else {
          await outbox.put(expected.after.outbox);
          await tx.objectStore("vaultSyncState").put(expected.after.ledger, `memory:${after.id}`);
        }
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }
  async function commitMemoryRepairTransaction(t) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "conversations", "vaultOutbox", "settings"], "readwrite");
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let result = "committed";
    try {
      const memories = tx.objectStore("memoryObjects"), conversations = tx.objectStore("conversations");
      const outbox = tx.objectStore("vaultOutbox"), settings = tx.objectStore("settings");
      const ledger = await settings.get(t.ledgerKey);
      if (ledger !== void 0) {
        if (ledger !== t.ledgerValue) throw new Error("repair-ledger-conflict");
        result = "already-done";
      } else {
        const backup = { memories: [], conversations: [], outbox: [], absentMemoryIds: [], afterMemories: [], afterConversations: [] };
        for (const { before, after } of t.replaceMemories) {
          const current = await memories.get(before.id);
          if (!equal(current, before)) throw new Error("repair-precondition-changed");
          if (after.id !== before.id) throw new Error("repair-id-changed");
          backup.memories.push(before);
          backup.afterMemories.push(after);
        }
        for (const { before, after } of t.replaceConversations) {
          const current = await conversations.get(before.id);
          if (!equal(current, before)) throw new Error("repair-precondition-changed");
          if (after.id !== before.id) throw new Error("repair-id-changed");
          backup.conversations.push(before);
          backup.afterConversations.push(after);
        }
        for (const added of t.addMemories) {
          const existing = await memories.get(added.id);
          if (existing !== void 0 && !equal(existing, added)) throw new Error("repair-id-conflict");
          if (existing === void 0) backup.absentMemoryIds.push(added.id);
        }
        if (t.requireNoOtherMemoryFor?.length) {
          const addedIds = new Set(t.addMemories.map((m) => m.id));
          const all = await memories.getAll();
          if (all.some((m) => m.conversationId && t.requireNoOtherMemoryFor.includes(m.conversationId) && !addedIds.has(m.id) && m.metadata.source !== "system-generated")) throw new Error("repair-conversation-already-has-memory");
        }
        const enqueue = async (recordType, record, snapshot) => {
          const id = vaultOutboxIdFor(recordType, record.id);
          const existing = await outbox.get(id);
          if (snapshot) backup.outbox.push(existing ?? null);
          await outbox.put(buildOutboxEntryForUpdate(existing, recordType, record.id, record.updatedAt, t.now));
        };
        for (const { after } of t.replaceMemories) {
          await memories.put(after);
          await enqueue(after.metadata.source === "system-generated" ? "reflection" : "memory", after, true);
        }
        for (const added of t.addMemories) {
          if (await memories.get(added.id) === void 0) {
            await memories.put(added);
            await enqueue("memory", added, false);
          }
        }
        for (const { after } of t.replaceConversations) {
          await conversations.put(after);
          await enqueue("conversation", after, true);
        }
        await settings.put(JSON.stringify({ at: t.now, ...backup }), t.backupKey);
        await settings.put(t.ledgerValue, t.ledgerKey);
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
    return result;
  }
  async function readMemoryRepairSettings(keys) {
    const db = await getDB();
    const out = {};
    for (const key of keys) out[key] = await db.get("settings", key);
    return out;
  }
  async function commitMaintenanceRestore(t) {
    const db = await getDB();
    const tx = db.transaction(["memoryObjects", "conversations", "vaultOutbox", "vaultSyncState", "settings"], "readwrite");
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    try {
      const memories = tx.objectStore("memoryObjects"), conversations = tx.objectStore("conversations"), outbox = tx.objectStore("vaultOutbox");
      const ledger = tx.objectStore("vaultSyncState"), settings = tx.objectStore("settings");
      for (const e of t.memories) if (!equal(await memories.get(e.id) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
      for (const e of t.conversations) if (!equal(await conversations.get(e.id) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
      for (const e of t.outbox) if (!equal(await outbox.get(e.id) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
      for (const e of t.syncLedger) if (!equal(await ledger.get(e.key) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
      for (const e of t.settings) if (!equal(await settings.get(e.key) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
      for (const e of t.memories) {
        if (e.target === null) await memories.delete(e.id);
        else await memories.put(e.target);
      }
      for (const e of t.conversations) {
        if (e.target === null) await conversations.delete(e.id);
        else await conversations.put(e.target);
      }
      for (const e of t.outbox) {
        if (e.target === null) await outbox.delete(e.id);
        else await outbox.put(e.target);
      }
      for (const e of t.syncLedger) {
        if (e.target === null) await ledger.delete(e.key);
        else await ledger.put(e.target, e.key);
      }
      for (const e of t.settings) {
        if (e.target === null) await settings.delete(e.key);
        else await settings.put(e.target, e.key);
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }

  // src/lib/vaultWorldLock.ts
  var LOCK_NAME = "tsumugi-vault-world";
  var EXCLUSIVE_LOCK_TIMEOUT_MS = 15e3;
  var BROADCAST_CHANNEL_NAME = "tsumugi-vault-epoch";
  var StaleVaultTabError = class extends Error {
    constructor(message = "\u3053\u306E\u30BF\u30D6\u306E\u4FDD\u5B58\u5148\u306F\u3001\u5225\u306E\u30BF\u30D6\u3067\u306E\u5909\u66F4\u306B\u3088\u308A\u53E4\u304F\u306A\u3063\u3066\u3044\u307E\u3059\u3002") {
      super(message);
      this.name = "StaleVaultTabError";
    }
  };
  var IncompleteVaultWorldError = class extends Error {
    constructor(message = "\u4FDD\u5B58\u5148\u306E\u5207\u66FF\u304C\u5B8C\u4E86\u3057\u3066\u3044\u307E\u305B\u3093\u3002\u4FDD\u5B58\u5148\u3092\u9078\u3073\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002") {
      super(message);
      this.name = "IncompleteVaultWorldError";
    }
  };
  var tabVaultEpoch = null;
  function getTabVaultEpoch() {
    return tabVaultEpoch;
  }
  function setTabVaultEpoch(epoch) {
    tabVaultEpoch = epoch;
  }
  function locksSupported() {
    return typeof navigator !== "undefined" && typeof navigator.locks !== "undefined";
  }
  async function withRawLock(mode, fn, signal) {
    if (!locksSupported()) return fn();
    return navigator.locks.request(LOCK_NAME, { mode, signal }, fn);
  }
  async function withVaultWorldRead(fn) {
    return withRawLock("shared", async () => {
      let sharedEpoch;
      let committedStatus;
      let versionStatus;
      try {
        sharedEpoch = await getActiveVaultEpoch();
        committedStatus = await getCommittedVaultEpoch();
        versionStatus = await getVaultWorldJournalVersion();
      } catch (error) {
        console.error(
          "[Tsumugi] failed to read activeVaultEpoch/committedVaultEpoch/vaultWorldJournalVersion, refusing Memory World operation:",
          error
        );
        throw new StaleVaultTabError("\u4FDD\u5B58\u5148\u306E\u72B6\u614B\u3092\u78BA\u8A8D\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u64CD\u4F5C\u3092\u4E2D\u6B62\u3057\u307E\u3057\u305F\u3002");
      }
      if (tabVaultEpoch === null || sharedEpoch !== tabVaultEpoch) {
        throw new StaleVaultTabError();
      }
      if (versionStatus.status !== "current") {
        throw new IncompleteVaultWorldError();
      }
      if (committedStatus.status !== "valid" || committedStatus.epoch !== sharedEpoch) {
        throw new IncompleteVaultWorldError();
      }
      return fn();
    });
  }
  async function withStartupSharedLock(fn) {
    return withRawLock("shared", fn);
  }
  async function runVaultWorldExclusive(fn, timeoutMs = EXCLUSIVE_LOCK_TIMEOUT_MS) {
    if (!locksSupported()) {
      console.error("[Tsumugi] navigator.locks is unavailable; refusing exclusive vault-world operation for safety.");
      return { timedOut: true };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await navigator.locks.request(LOCK_NAME, { mode: "exclusive", signal: controller.signal }, async () => {
        let sharedEpoch;
        let committedStatus;
        let versionStatus;
        try {
          sharedEpoch = await getActiveVaultEpoch();
          committedStatus = await getCommittedVaultEpoch();
          versionStatus = await getVaultWorldJournalVersion();
        } catch (error) {
          console.error(
            "[Tsumugi] failed to read activeVaultEpoch/committedVaultEpoch/vaultWorldJournalVersion for resync, refusing:",
            error
          );
          throw new StaleVaultTabError("\u4FDD\u5B58\u5148\u306E\u72B6\u614B\u3092\u78BA\u8A8D\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u518D\u540C\u671F\u3092\u4E2D\u6B62\u3057\u307E\u3057\u305F\u3002");
        }
        if (tabVaultEpoch === null || sharedEpoch !== tabVaultEpoch) {
          throw new StaleVaultTabError();
        }
        if (versionStatus.status !== "current") {
          throw new IncompleteVaultWorldError();
        }
        if (committedStatus.status !== "valid" || committedStatus.epoch !== sharedEpoch) {
          throw new IncompleteVaultWorldError();
        }
        return fn();
      });
      return { timedOut: false, result };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { timedOut: true };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  function runVaultSwitchExclusive(fn, timeoutMs = EXCLUSIVE_LOCK_TIMEOUT_MS) {
    if (!locksSupported()) {
      console.error("[Tsumugi] navigator.locks is unavailable; refusing cross-tab vault switch for safety.");
      return Promise.resolve({ timedOut: true });
    }
    let phase = "preparing";
    let settleOuter = null;
    let failOuter = null;
    const outer = new Promise((resolve, reject) => {
      settleOuter = resolve;
      failOuter = reject;
    });
    const ctx = {
      beginCommit: () => {
        if (phase !== "preparing") return false;
        phase = "committing";
        return true;
      }
    };
    const timer = setTimeout(() => {
      if (phase === "preparing") {
        phase = "timed-out";
        settleOuter({ timedOut: true });
      }
    }, timeoutMs);
    void navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, async () => {
      if (phase === "timed-out") return void 0;
      return fn(ctx);
    }).then((result) => {
      clearTimeout(timer);
      if (phase === "timed-out") {
        return;
      }
      phase = "finished";
      settleOuter({ timedOut: false, result });
    }).catch((error) => {
      clearTimeout(timer);
      if (phase === "timed-out") {
        console.error(
          "[Tsumugi] vault switch exclusive task failed after timeout was already reported to caller:",
          error
        );
        return;
      }
      phase = "finished";
      failOuter(error);
    });
    return outer;
  }
  var channel = null;
  function getChannel() {
    if (typeof BroadcastChannel === "undefined") return null;
    if (!channel) {
      try {
        channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      } catch (error) {
        console.error("[Tsumugi] failed to open BroadcastChannel (UX notification only, safety unaffected):", error);
        return null;
      }
    }
    return channel;
  }
  function notifyVaultSwitched(epoch) {
    try {
      const message = { type: "vault-switched", epoch };
      getChannel()?.postMessage(message);
    } catch (error) {
      console.error("[Tsumugi] failed to broadcast vault switch notification (UX only):", error);
    }
  }
  function subscribeVaultSwitchNotifications(onSwitch) {
    const ch = getChannel();
    if (!ch) return () => {
    };
    const handler = (event) => {
      if (event.data && event.data.type === "vault-switched" && typeof event.data.epoch === "number") {
        onSwitch(event.data.epoch);
      }
    };
    ch.addEventListener("message", handler);
    return () => ch.removeEventListener("message", handler);
  }

  // src/lib/maintenance/maintenanceWindow.ts
  var maintenanceWindow_exports = {};
  __export(maintenanceWindow_exports, {
    MaintenanceWriteAccessError: () => MaintenanceWriteAccessError,
    VAULT_WORLD_LOCK_NAME: () => VAULT_WORLD_LOCK_NAME,
    __simulateTabLossForTests: () => __simulateTabLossForTests,
    endMaintenanceWindow: () => endMaintenanceWindow,
    enterMaintenanceWindow: () => enterMaintenanceWindow,
    isMaintenanceWindowOpen: () => isMaintenanceWindowOpen,
    releaseStaleMaintenanceGate: () => releaseStaleMaintenanceGate,
    runWithMaintenanceWriteAccess: () => runWithMaintenanceWriteAccess
  });

  // src/lib/vaultRecoveryJournal.ts
  var vaultRecoveryJournal_exports = {};
  __export(vaultRecoveryJournal_exports, {
    RECOVERY_JOURNAL_VERSION: () => RECOVERY_JOURNAL_VERSION,
    RecoveryJournalUnavailableError: () => RecoveryJournalUnavailableError,
    VaultRecoveryPendingError: () => VaultRecoveryPendingError,
    assertNoPendingRecovery: () => assertNoPendingRecovery,
    dbRecoveryJournalStore: () => dbRecoveryJournalStore,
    isRecoveryBlockingNormalWrites: () => isRecoveryBlockingNormalWrites,
    isRecoveryWriteAccessActive: () => isRecoveryWriteAccessActive,
    parseRecoveryJournal: () => parseRecoveryJournal,
    readRecoveryJournal: () => readRecoveryJournal,
    runWithRecoveryWriteAccess: () => runWithRecoveryWriteAccess,
    saveRecoveryJournal: () => saveRecoveryJournal,
    setMaintenanceWriteAccessProbe: () => setMaintenanceWriteAccessProbe
  });
  var RECOVERY_JOURNAL_VERSION = 1;
  var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  var str = (x) => typeof x === "string";
  var strOrNull = (x) => x === null || typeof x === "string";
  var OP_KINDS = ["create", "create-day", "repair"];
  var RECORD_TYPES = ["conversation", "source", "reflection", "memory"];
  var STEP_NAMES = ["markdown", "index", "history", "registry", "ledger"];
  var STEP_STATES = ["pending", "done", "not-needed"];
  function validMember(m) {
    return object(m) && str(m.id) && RECORD_TYPES.includes(String(m.recordType)) && str(m.syncKey) && str(m.updatedAt) && str(m.recordHash);
  }
  function validMetadataBackup(b) {
    return object(b) && str(b.path) && strOrNull(b.beforeContent) && strOrNull(b.beforeHash) && strOrNull(b.afterHash);
  }
  function validOp(o) {
    if (!object(o) || !str(o.opId) || !OP_KINDS.includes(String(o.kind)) || !RECORD_TYPES.includes(String(o.recordType))) return false;
    if (!strOrNull(o.day) || !Array.isArray(o.members) || !o.members.every(validMember) || !str(o.path)) return false;
    if (!str(o.expectedContentHash) || typeof o.expectedContentLength !== "number" || !str(o.registryKey)) return false;
    if (!["pending", "verified", "failed"].includes(String(o.status)) || !strOrNull(o.failure)) return false;
    if (!Array.isArray(o.metadataBackups) || !o.metadataBackups.every(validMetadataBackup)) return false;
    if (!object(o.steps) || !STEP_NAMES.every((name) => STEP_STATES.includes(String(o.steps[name])))) return false;
    const e = o.expected;
    if (!object(e) || !Array.isArray(e.indexEntries) || !Array.isArray(e.ledger)) return false;
    if (!e.indexEntries.every((x) => object(x) && str(x.id) && str(x.path))) return false;
    if (!e.ledger.every((x) => object(x) && str(x.key) && str(x.value))) return false;
    if (e.registry !== null && !(object(e.registry) && str(e.registry.key) && str(e.registry.path) && str(e.registry.contentHash) && Array.isArray(e.registry.memberIds))) return false;
    if (e.history !== null && !(object(e.history) && str(e.history.day) && Array.isArray(e.history.ids))) return false;
    return true;
  }
  function parseRecoveryJournal(raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!object(value) || value.version !== RECOVERY_JOURNAL_VERSION || !str(value.operationId)) return null;
    if (!["in-progress", "completed", "abandoned"].includes(String(value.status))) return null;
    if (!str(value.createdAt) || !str(value.updatedAt)) return null;
    const w = value.world;
    if (!object(w) || typeof w.activeVaultEpoch !== "number" || !(w.committedVaultEpoch === null || typeof w.committedVaultEpoch === "number") || typeof w.registryGenerationEpoch !== "number" || !str(w.journalVersion) || !strOrNull(w.backend)) return null;
    const b = value.baselineAtStart;
    if (!object(b) || !str(b.status) || !strOrNull(b.value)) return null;
    if (!object(value.managedBefore) || !Object.values(value.managedBefore).every(strOrNull)) return null;
    if (!Array.isArray(value.ops) || !value.ops.every(validOp)) return null;
    if (!Array.isArray(value.held) || !value.held.every((h) => object(h) && str(h.recordType) && str(h.recordId) && str(h.reason))) return null;
    const r = value.result;
    if (r !== null && !(object(r) && typeof r.recovered === "number" && typeof r.held === "number" && typeof r.failed === "number")) return null;
    if (typeof value.unresolvedMetadata !== "boolean") return null;
    return value;
  }
  var dbRecoveryJournalStore = {
    read: readRecoveryJournalRaw,
    write: writeRecoveryJournalRaw
  };
  var RecoveryJournalUnavailableError = class extends Error {
    constructor(message = "recovery journal could not be saved and read back") {
      super(message);
      this.name = "RecoveryJournalUnavailableError";
    }
  };
  async function saveRecoveryJournal(store, journal) {
    const text = JSON.stringify(journal);
    try {
      await store.write(text);
      const back = await store.read();
      if (back !== text) throw new RecoveryJournalUnavailableError("recovery journal read-back mismatch");
    } catch (error) {
      if (error instanceof RecoveryJournalUnavailableError) throw error;
      throw new RecoveryJournalUnavailableError();
    }
  }
  async function readRecoveryJournal(store = dbRecoveryJournalStore) {
    const raw = await store.read();
    if (raw === void 0) return { kind: "none" };
    const journal = parseRecoveryJournal(raw);
    return journal ? { kind: "journal", journal } : { kind: "unreadable" };
  }
  var VaultRecoveryPendingError = class extends Error {
    constructor() {
      super("[Tsumugi] vault write deferred: an unfinished recovery is pending (normal writes resume after it is finished).");
      this.name = "VaultRecoveryPendingError";
    }
  };
  async function isRecoveryBlockingNormalWrites(store = dbRecoveryJournalStore, readEpoch = getActiveVaultEpoch) {
    let read;
    try {
      read = await readRecoveryJournal(store);
    } catch {
      return true;
    }
    if (read.kind === "none") return false;
    if (read.kind === "unreadable") return true;
    if (read.journal.status !== "in-progress") return false;
    try {
      return await readEpoch() === read.journal.world.activeVaultEpoch;
    } catch {
      return true;
    }
  }
  async function assertNoPendingRecovery(store = dbRecoveryJournalStore, readEpoch = getActiveVaultEpoch) {
    if (await isRecoveryBlockingNormalWrites(store, readEpoch)) throw new VaultRecoveryPendingError();
  }
  var recoveryWriteAccessDepth = 0;
  function runWithRecoveryWriteAccess(fn) {
    recoveryWriteAccessDepth += 1;
    try {
      return fn();
    } finally {
      recoveryWriteAccessDepth -= 1;
    }
  }
  var maintenanceWriteAccessProbe = null;
  function setMaintenanceWriteAccessProbe(probe) {
    maintenanceWriteAccessProbe = probe;
  }
  function isRecoveryWriteAccessActive() {
    if (recoveryWriteAccessDepth > 0) return true;
    if (maintenanceWriteAccessProbe === null) return false;
    try {
      return maintenanceWriteAccessProbe() === true;
    } catch {
      return false;
    }
  }

  // src/lib/maintenance/maintenanceGate.ts
  var maintenanceGate_exports = {};
  __export(maintenanceGate_exports, {
    MAINTENANCE_GATE_KIND: () => MAINTENANCE_GATE_KIND,
    closeMaintenanceGate: () => closeMaintenanceGate,
    isMaintenanceJournal: () => isMaintenanceJournal,
    openMaintenanceGate: () => openMaintenanceGate,
    readGateState: () => readGateState,
    readProductionWorld: () => readProductionWorld
  });

  // src/lib/vaultSaveLock.ts
  var tail = Promise.resolve();

  // src/lib/vaultWriter.ts
  function prototypeHasWritable() {
    try {
      return typeof FileSystemFileHandle !== "undefined" && typeof FileSystemFileHandle.prototype.createWritable === "function";
    } catch {
      return false;
    }
  }
  var writerState = "unknown";
  function getOpfsWriterState() {
    if (prototypeHasWritable()) return "native";
    return writerState;
  }
  var chain = Promise.resolve();

  // src/lib/vault.ts
  var vaultRegistryInstanceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `fallback-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  function isFsAccessSupported() {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
  }
  function isOpfsSupported() {
    return typeof navigator !== "undefined" && typeof navigator.storage !== "undefined" && typeof navigator.storage.getDirectory === "function";
  }
  function isAndroid() {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  }
  function getVaultBackend() {
    if (isAndroid()) return isOpfsSupported() ? opfsBackendIfWritable() : null;
    if (isFsAccessSupported()) return "file-system-access";
    if (isOpfsSupported()) return opfsBackendIfWritable();
    return null;
  }
  function opfsBackendIfWritable() {
    return getOpfsWriterState() === "unavailable" ? null : "opfs";
  }

  // src/lib/maintenance/maintenanceGate.ts
  var MAINTENANCE_GATE_KIND = "maintenance-window";
  async function readProductionWorld() {
    const committed = await getCommittedVaultEpoch();
    const version = await getVaultWorldJournalVersion();
    return {
      activeVaultEpoch: await getActiveVaultEpoch(),
      committedVaultEpoch: committed.status === "valid" ? committed.epoch : null,
      registryGenerationEpoch: await getRegistryGenerationEpoch(),
      journalVersion: version.status === "current" ? "current" : version.status === "missing" ? "missing" : `unexpected:${version.raw}`,
      backend: getVaultBackend()
    };
  }
  var isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
  function isMaintenanceJournal(journal) {
    const p = journal.narrowMemoryRepair;
    return isObject(p) && p.kind === MAINTENANCE_GATE_KIND;
  }
  var defaultId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  async function openMaintenanceGate(purpose, deps = {}) {
    const store = deps.store ?? dbRecoveryJournalStore;
    let previous;
    try {
      previous = await readRecoveryJournal(store);
    } catch {
      return { ok: false, reason: "journal-unreadable" };
    }
    if (previous.kind === "unreadable") return { ok: false, reason: "journal-unreadable" };
    if (previous.kind === "journal" && previous.journal.status === "in-progress") {
      return { ok: false, reason: isMaintenanceJournal(previous.journal) ? "maintenance-gate-already-open" : "other-journal-in-progress" };
    }
    let world;
    try {
      world = await (deps.readWorld ?? readProductionWorld)();
    } catch {
      return { ok: false, reason: "world-unreadable" };
    }
    const now = (deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
    const operationId = (deps.newId ?? defaultId)();
    const payload = { kind: MAINTENANCE_GATE_KIND, version: 1, purpose, openedAt: now };
    const journal = {
      version: RECOVERY_JOURNAL_VERSION,
      operationId,
      status: "in-progress",
      createdAt: now,
      updatedAt: now,
      world,
      baselineAtStart: { status: MAINTENANCE_GATE_KIND, value: null },
      managedBefore: {},
      ops: [],
      held: [],
      result: null,
      unresolvedMetadata: false,
      narrowMemoryRepair: payload
    };
    try {
      await saveRecoveryJournal(store, journal);
    } catch {
      return { ok: false, reason: "journal-not-saved" };
    }
    return { ok: true, operationId };
  }
  async function closeMaintenanceGate(operationId, deps = {}) {
    const store = deps.store ?? dbRecoveryJournalStore;
    let read;
    try {
      read = await readRecoveryJournal(store);
    } catch {
      return { closed: false, reason: "journal-unreadable" };
    }
    if (read.kind === "none") return { closed: false, reason: "no-journal" };
    if (read.kind === "unreadable") return { closed: false, reason: "journal-unreadable" };
    const j = read.journal;
    if (!isMaintenanceJournal(j)) return { closed: false, reason: "not-a-maintenance-gate" };
    if (j.status !== "in-progress") return { closed: false, reason: "not-in-progress" };
    if (operationId !== null && j.operationId !== operationId) return { closed: false, reason: "different-operation" };
    const now = (deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
    try {
      await saveRecoveryJournal(store, { ...j, status: "completed", updatedAt: now, result: { recovered: 0, held: 0, failed: 0 } });
    } catch {
      return { closed: false, reason: "journal-not-saved" };
    }
    return { closed: true };
  }
  async function readGateState(store = dbRecoveryJournalStore) {
    let read;
    try {
      read = await readRecoveryJournal(store);
    } catch {
      return { kind: "unreadable" };
    }
    if (read.kind === "none") return { kind: "none" };
    if (read.kind === "unreadable") return { kind: "unreadable" };
    if (read.journal.status !== "in-progress") return { kind: "finished" };
    if (!isMaintenanceJournal(read.journal)) return { kind: "other-in-progress" };
    return { kind: "maintenance-open", operationId: read.journal.operationId, openedAt: String(read.journal.narrowMemoryRepair.openedAt ?? "") };
  }

  // src/lib/maintenance/maintenanceWindow.ts
  var VAULT_WORLD_LOCK_NAME = "tsumugi-vault-world";
  var MaintenanceWriteAccessError = class extends Error {
    constructor(reason) {
      super(`maintenance write access refused: ${reason}`);
      this.reason = reason;
      this.name = "MaintenanceWriteAccessError";
    }
  };
  var defaultQueryLocks = async () => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : void 0;
    return locks && typeof locks.query === "function" ? locks.query() : null;
  };
  var held = null;
  function inMaintenanceContext() {
    const loc = globalThis.location;
    if (!loc || typeof loc.pathname !== "string") return true;
    return loc.pathname === "/maintenance" || loc.pathname.startsWith("/maintenance/");
  }
  var permitted = () => held !== null && held.scopeDepth > 0 && inMaintenanceContext();
  function isMaintenanceWindowOpen() {
    return held !== null;
  }
  async function enterMaintenanceWindow(opts) {
    if (held) return { ok: false, reason: "window-already-open" };
    if (!inMaintenanceContext()) return { ok: false, reason: "not-maintenance-context" };
    try {
      const snap = await (opts.queryLocks ?? defaultQueryLocks)();
      const others = [...snap?.held ?? [], ...snap?.pending ?? []].filter((l) => l.name === VAULT_WORLD_LOCK_NAME);
      if (others.length > 0) return { ok: false, reason: "lock-contention" };
    } catch {
    }
    let signalAcquired;
    let releaseHold;
    const acquired = new Promise((r) => {
      signalAcquired = r;
    });
    const hold = new Promise((r) => {
      releaseHold = r;
    });
    const settled = runVaultWorldExclusive(async () => {
      signalAcquired();
      await hold;
    }, opts.timeoutMs).then((r) => ({ r }), (error) => ({ error }));
    const first = await Promise.race([acquired.then(() => "held"), settled]);
    if (first !== "held") {
      if ("error" in first) return { ok: false, reason: `lock-error:${first.error?.name ?? "error"}` };
      return { ok: false, reason: "lock-unavailable" };
    }
    const gate = await openMaintenanceGate(opts.purpose, opts);
    if (!gate.ok) {
      releaseHold();
      await settled;
      return { ok: false, reason: gate.reason };
    }
    held = { operationId: gate.operationId, release: releaseHold, settled, scopeDepth: 0, deps: opts };
    setMaintenanceWriteAccessProbe(permitted);
    return { ok: true, operationId: gate.operationId };
  }
  async function endMaintenanceWindow() {
    const h = held;
    if (!h) return { ok: false, reason: "no-window" };
    if (h.scopeDepth > 0) return { ok: false, reason: "write-scope-active" };
    const closed = await closeMaintenanceGate(h.operationId, h.deps);
    held = null;
    setMaintenanceWriteAccessProbe(null);
    h.release();
    await h.settled;
    return closed.closed ? { ok: true, gateClosed: true } : { ok: true, gateClosed: false, reason: closed.reason };
  }
  async function runWithMaintenanceWriteAccess(fn) {
    const h = held;
    if (!h) throw new MaintenanceWriteAccessError("no-window");
    if (!inMaintenanceContext()) throw new MaintenanceWriteAccessError("not-maintenance-context");
    h.scopeDepth += 1;
    try {
      return await fn();
    } finally {
      h.scopeDepth -= 1;
    }
  }
  async function releaseStaleMaintenanceGate(opts = {}) {
    if (held) return { released: false, reason: "window-open-in-this-tab" };
    if (!inMaintenanceContext()) return { released: false, reason: "not-maintenance-context" };
    try {
      const snap = await (opts.queryLocks ?? defaultQueryLocks)();
      if ([...snap?.held ?? [], ...snap?.pending ?? []].some((l) => l.name === VAULT_WORLD_LOCK_NAME)) return { released: false, reason: "lock-contention" };
    } catch {
    }
    try {
      const r = await runVaultWorldExclusive(() => closeMaintenanceGate(null, opts), opts.timeoutMs);
      const result = r.result;
      if (r.timedOut || !result) return { released: false, reason: "lock-unavailable" };
      return result.closed ? { released: true } : { released: false, reason: result.reason === "no-journal" || result.reason === "not-in-progress" ? "no-maintenance-gate" : result.reason };
    } catch (error) {
      return { released: false, reason: `lock-error:${error?.name ?? "error"}` };
    }
  }
  function __simulateTabLossForTests() {
    const h = held;
    held = null;
    setMaintenanceWriteAccessProbe(null);
    h?.release();
  }

  // scripts/browser-harness/entry.ts
  var NOW = (/* @__PURE__ */ new Date()).toISOString();
  async function prepare() {
    await putVaultIdentityRecord({ id: "current", vaultId: "harness-vault", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW });
    await markVaultEpochCommitted(0);
    await markVaultWorldJournalMigrated();
    setTabVaultEpoch(0);
  }
  globalThis.H = { lock: vaultWorldLock_exports, win: maintenanceWindow_exports, gate: maintenanceGate_exports, db: db_exports, journal: vaultRecoveryJournal_exports, prepare };
})();
