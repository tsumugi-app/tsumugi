"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation, ConversationTurn, MemoryObject, Persona } from "@/lib/types";
import { appendTurn, captureConversation, createConversation, persistCapture, persistConversation } from "@/lib/capture";
import {
  chooseVaultDirectory,
  clearOpfsVault,
  collectAllMarkdownFiles,
  flushPendingToVault,
  getVaultBackend,
  isVaultSupported,
  requestVaultPermission,
  restoreVaultHandle,
  scanVaultForRestore,
  type VaultScanResult,
} from "@/lib/vault";
import {
  clearApiKey,
  clearMemoryData,
  clearVaultSyncState,
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  loadApiKey,
  loadChatProvider,
  putConversation,
  putMemoryObject,
  saveChatProvider,
  saveSource,
} from "@/lib/db";
import { createZipBlob } from "@/lib/zip";
import { getGreeting } from "@/lib/greeting";
import {
  isReflectiveQuery,
  REFLECTIVE_LIMIT,
  REFLECTIVE_MAX_LINKED_ADDITIONS,
  retrieveRelevantMemories,
} from "@/lib/retrieval";
import { createInsightMemoryObject, generateSessionReflection } from "@/lib/reflection";
import { connectMemory } from "@/lib/connect";
import { filterUnconnected } from "@/lib/connectState";
import { AI_PROVIDER_HEADER, API_KEY_HEADER_BY_PROVIDER } from "@/lib/apiKeyHeader";
import { generateRevisitPrompt, generateTopPrompt, type TopPrompt } from "@/lib/topPrompt";
import { useWaitingMessage } from "@/lib/useWaitingMessage";
import ApiKeySetup from "./ApiKeySetup";
import SettingsPanel from "./SettingsPanel";
import ImportPanel from "./ImportPanel";
// TEMP-TEST：20〜40秒の異常遅延の原因切り分け用診断パネル。`?debugLog=1`以外では何も描画しない。
import DebugTimingPanel from "./DebugTimingPanel";
import HistoryPanel from "./HistoryPanel";

/** ApiKeySetupと同じく、chatで選べるproviderは今回この2つに限定する（Claudeは型のみ）。 */
export type SupportedChatProvider = "gemini" | "openai";

export type VaultStatus = "checking" | "connected" | "not-connected" | "unsupported" | "needs-permission";
/** Beta C3対応：フォルダ選択のキャンセル／接続失敗を、vaultStatusを汚さずに一時的なメッセージとして出す。 */
export type VaultConnectFeedback = { kind: "cancelled" | "error"; message: string };
type CaptureStatus = "idle" | "saving" | "saved" | "partial" | "error";
/**
 * "capturing"：「本日はここまで」を押した直後〜runConversationBoundary()の解決待ちの間。
 * このConversationがまだCaptureされていなければ、ここで初めて/api/captureが呼ばれる
 * （会話中は毎ターンCaptureしていないため）。ボタン押下からここまで画面上に一切表示が
 * 無かったため追加した（UI改善のみ）。
 */
type ReflectionStatus = "idle" | "capturing" | "generating" | "done" | "error" | "unavailable";
export type RestoreStatus = "idle" | "restoring" | "done";
/**
 * 「Markdownをエクスポート」「この端末のデータを削除」（iPhone/iPad＝OPFSが対象）の
 * 進行状況・結果表示用。busy中はボタンをdisabledにし、他の結果（success/empty/error）は
 * 既存のvaultConnectFeedback等と同じく数秒後に自動で消す。
 */
export type DataActionFeedback = { kind: "busy" | "success" | "empty" | "error"; message: string };
type SendStatus = "idle" | "error" | "authError";

export interface RestoreCandidate {
  scan: VaultScanResult;
  newCount: number;
}

/** 1回のアプリ起動あたり、未Connect Memoryをまとめて処理する上限（AI呼び出し回数のクォータ保護）。 */
const STARTUP_CONNECT_LIMIT = 3;

/**
 * 1回のアプリ起動あたり、未Capture Conversation（明示的な終了操作をせずブラウザ/タブを
 * 閉じた等で、status==="active"のまま残ったもの）をまとめて処理する上限。
 * STARTUP_CONNECT_LIMITと同じ考え方（AI呼び出し回数のクォータ保護）。
 */
const STARTUP_CAPTURE_LIMIT = 3;

/** Beta C4：/api/chatの失敗時、ステータスだけを見てAPIキー由来かどうかをUI側で分岐するための最小限のエラー型。 */
class ChatRequestError extends Error {
  constructor(readonly status: number) {
    super(`chat request failed: ${status}`);
  }
}

const PERSONAS: {
  value: Persona;
  label: string;
  hint: string;
  placeholder: string;
  openingMessage: string;
}[] = [
  {
    value: "companion",
    label: "日記",
    hint: "寄り添う",
    placeholder: "今日はどんな一日でしたか？",
    openingMessage: "今日はどんな一日でしたか？",
  },
  {
    value: "coach",
    label: "探究",
    hint: "問いかける",
    placeholder: "最近、気になることは？",
    openingMessage: "最近、何について知りたいですか？",
  },
  {
    value: "analyst",
    label: "相談・創造",
    hint: "整理する",
    placeholder: "今、一緒に考えたいことは？",
    openingMessage: "今、何について一緒に考えてみたいですか？",
  },
];

/** 通常時のコンパクト表示（`Gemini ・ test ・ ⚙`）で使うラベル。既存UIの表記（895/907行付近）に合わせる。 */
const PROVIDER_LABEL: Record<SupportedChatProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
};

export default function ChatScreen() {
  const [persona, setPersona] = useState<Persona>("companion");
  const [entryConfirmed, setEntryConfirmed] = useState(false);
  const [conversation, setConversation] = useState<Conversation>(() => createConversation("companion"));
  /**
   * そのConversationから既に生成済みの、新規/更新されたMemoryObjectの一覧
   * （1 Conversation = 1 Memoryとは限らない）。値自体を直接読む箇所は無いが、
   * runConversationBoundary・enqueueRevisitPromptGenerationが更新し続ける
   * （将来の機能・デバッグ用に、常に最新の状態を保つ）。
   */
  const [, setMemoryObjects] = useState<MemoryObject[]>([]);
  /**
   * 「この会話を終える」（handleEndConversation）を押した直後だけ表示する、
   * 「ここまでを記憶しました。」カード用のstate。
   * null＝まだ会話中（カードは出さない。会話中に常時Memoryの保存状況を表示する
   * UXは今回廃止した）。配列（0件を含む）＝会話がちょうど終わり、その時点での
   * memoryObjects（このConversationで生成・更新された全Memory、累積）をそのまま
   * 保持している状態。0件の場合は「今回は新しく記憶したことはありませんでした。」
   * のような、嘘にならない表示に出し分ける（呼び出し側で判定）。
   * 会話境界（ペルソナ切替・トップへ戻る・終了済み会話からの新規開始）では
   * memoryObjectsと同じタイミングでnullへリセットする。
   */
  const [endedConversationMemories, setEndedConversationMemories] = useState<MemoryObject[] | null>(null);
  /** handleEndConversation実行中、ボタンの連打を防ぐためだけの表示用フラグ。 */
  const [endingConversation, setEndingConversation] = useState(false);
  /**
   * 入力中のテキスト自体は`ChatInput`（下部で定義する子コンポーネント）が自分の
   * ローカルstateとして持つ（1文字ごとのsetStateがChatScreen全体の再レンダリングを
   * 引き起こさないようにするため。詳細はChatInputのコメント参照）。
   * ChatScreen側にはもう`input`のuseStateは無い。ペルソナ切替・トップへ戻る際に
   * 「入力中の下書きをクリアする」という既存仕様だけは、ChatInputの外側から
   * リセットする必要があるため、`key`をインクリメントしてChatInputごと
   * 再マウントさせることで実現する（Reactの標準的な「keyでstateをリセットする」
   * パターン。ChatInput自身のuseStateを直接いじる手段は持たせない）。
   */
  const [inputResetKey, setInputResetKey] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const { message: waitingMessage, start: startWaiting, stop: stopWaiting } = useWaitingMessage();
  const [vaultHandle, setVaultHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("checking");
  const [vaultConnectFeedback, setVaultConnectFeedback] = useState<VaultConnectFeedback | null>(null);
  /** 「Markdownをエクスポート」「この端末のデータを削除」（SettingsPanelのデータ欄）の状態。 */
  const [exportDataFeedback, setExportDataFeedback] = useState<DataActionFeedback | null>(null);
  const [deleteDataFeedback, setDeleteDataFeedback] = useState<DataActionFeedback | null>(null);
  /**
   * トップ画面の「アクセスを再許可」カードの「あとで」で非表示にしたかどうか。
   * ページセッション中のみ有効（stateなのでリロードで自動的にfalseへ戻り、
   * needs-permissionが続いていれば再度カードが表示される）。
   */
  const [vaultReauthDismissed, setVaultReauthDismissed] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [reflectionStatus, setReflectionStatus] = useState<ReflectionStatus>("idle");
  const [reflectionText, setReflectionText] = useState("");
  const [restoreCandidate, setRestoreCandidate] = useState<RestoreCandidate | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>("idle");
  const [greeting] = useState(() => getGreeting());
  /** Beta「過去からの問いかけ」。候補が無い/生成に失敗した場合はnullのままで、トップ画面は従来通りになる。 */
  const [topPrompt, setTopPrompt] = useState<TopPrompt | null>(null);
  const [topPromptInput, setTopPromptInput] = useState("");
  /**
   * 「APIキーを登録するprovider」とは別の概念：chatの送信（companion/coach/analyst）に
   * 実際に使うprovider。既定はGemini（既存動作の完全維持のため）。Capture/Connect/
   * Reflection/問いかけ生成はこの値を参照しない（今回のPhaseでは引き続きGemini固定）。
   */
  const [chatProvider, setChatProvider] = useState<SupportedChatProvider>("gemini");
  const [keyStatusByProvider, setKeyStatusByProvider] = useState<Record<SupportedChatProvider, boolean>>({
    gemini: false,
    openai: false,
  });
  /** nullなら閉じている。値があれば、そのproviderのタブを開いた状態でApiKeySetupをオーバーレイ表示する。 */
  const [apiKeySetupProvider, setApiKeySetupProvider] = useState<SupportedChatProvider | null>(null);
  /** 通常時は`Gemini ・ test ・ ⚙`の1行のみ表示し、⚙で開閉するSettingsPanelの開閉状態。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 入力欄の＋ボタンで開閉するImportPanelの開閉状態。 */
  const [importOpen, setImportOpen] = useState(false);
  /** 入力欄の↺ボタンで開閉するHistoryPanel（過去の記憶を見返す）の開閉状態。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * 「記憶しました」カードの「詳細を見る」から開いた場合だけ、そのMemoryの詳細へ
   * 直接ジャンプするために使う（HistoryPanelのinitialMemoryId propへ渡す）。
   * 通常の↺ボタンから開く場合はundefinedのまま（従来どおりの挙動）。
   * HistoryPanelを閉じるたびに必ずundefinedへ戻す（次に↺ボタンから開いたときに
   * 古いジャンプ先が残らないようにするため）。
   */
  const [historyInitialMemoryId, setHistoryInitialMemoryId] = useState<string | undefined>(undefined);
  /**
   * スマホでソフトウェアキーボードが表示中かどうか。footer・下部アイコン行の
   * 余白圧縮だけに使う表示専用state（Vault/Memory等の既存ロジックには一切関係しない）。
   * PC幅ではCSS側（各所の`sm:`）が常にこのstateの値を上書きするため、たとえこのstateが
   * 誤ってtrueになってもPCの見た目には影響しない。
   */
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const topPromptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const startupConnectRanRef = useRef(false);
  const startupCaptureRanRef = useRef(false);
  const topPromptRanRef = useRef(false);
  /** setConversationを呼ぶ箇所では必ず同時に更新する、常に最新のconversationを指すref。 */
  const latestConversationRef = useRef(conversation);

  /**
   * Beta「過去からの問いかけ」用のrevisitPrompt生成を、runConversationBoundary()の
   * 解決を待たせないバックグラウンド処理として切り出したもの。
   *
   * 背景：以前はCapture処理内でrevisitPrompt生成（/api/prompt、Memoryごとに1回）の
   * 完了まで、終了処理が待たされていたため、「本日はここまで」「この会話を終える」の
   * 表示が遅くなっていた。revisitPromptはトップ画面の「過去からの問いかけ」でのみ使われ、
   * 「ここまでを記憶しました」・終了時に表示するMemory・日記の振り返り・
   * conversationの終了状態のいずれにも必要ないため、終了処理の待機対象から外す。
   *
   * revisitPromptをまだ持たないMemory（＝今回新しく生成された、または初めてCaptureされた
   * Memory）だけを対象に、そのMemory単体を材料として再訪用の問いかけを1回だけ生成し、
   * 保存し直す（既にrevisitPromptを持つMemoryは再生成しない、失敗しても既存のCapture
   * 結果自体は失わない——という既存の挙動・粒度は変更していない）。
   * 生成が完了したMemoryはmemoryObjects stateへも反映する（画面に既に表示されている
   * Memoryへ、revisitPromptだけが後から追記される形になる）。
   */
  function enqueueRevisitPromptGeneration(memories: MemoryObject[]) {
    const targets = memories.filter((memory) => !memory.revisitPrompt);
    if (targets.length === 0) return;
    void Promise.all(
      targets.map(async (memory) => {
        try {
          const revisitPrompt = await generateRevisitPrompt(memory);
          if (!revisitPrompt) return;
          const memoryWithPrompt: MemoryObject = { ...memory, revisitPrompt };
          await putMemoryObject(memoryWithPrompt);
          setMemoryObjects((prev) => prev.map((m) => (m.id === memoryWithPrompt.id ? memoryWithPrompt : m)));
        } catch (error) {
          console.error("Failed to generate revisit prompt", error);
        }
      })
    );
  }

  /**
   * 渡されたMemory一覧をConnect対象にする、共通のfire-and-forgetヘルパー。
   * runConversationBoundary()の最後で必ず呼ばれるほか、handleEndSession()が
   * insightMemory（Reflection自体）だけを追加でConnectする際にもそのまま再利用する。
   * 新しいConnect機構・新しいタイマーは作らない。
   *
   * 同じMemoryが複数の経路（Boundary Capture・起動時キャッチアップ等）から対象になっても、
   * connectMemory()内のtryClaimMemoryForConnect()による既存のクレーム機構がそのまま
   * 重複実行を防ぐ。
   */
  function connectConversationBoundary(pendingMemoryObjects: Promise<MemoryObject[]>) {
    void (async () => {
      try {
        const memories = await pendingMemoryObjects;
        for (const memory of memories) {
          await connectMemory(vaultHandle, memory);
        }
      } catch (error) {
        console.error("Failed to connect conversation-boundary memories", error);
      }
    })();
  }

  /**
   * Conversation Boundary（会話の区切り）でのCapture→Memory保存→revisitPrompt発火→Connect。
   * 「本日はここまで」「この会話を終える」・persona切替・トップへ戻る・終了済み
   * Conversationからの新規開始・起動時の未Capture救済、全ての離脱経路からこの1つの
   * 関数を呼ぶ（docs/MEMORY_ENGINE.md「会話が終わると、Memory Engineは会話をMemory
   * Objectへ変換する」という原案に沿った再設計。以前は毎ターン自動発火していたが、
   * Captureは今回からConversationごとに1回、この関数が呼ばれた時だけ実行する）。
   *
   * targetが既にstatus==="captured"、またはturnsが空なら何もせず空配列を返す
   * （二重Captureを防ぐ。Conversation.status自体を「Captureしたか」のマーカーとして使い、
   * connectStateのような別のクレーム機構は導入しない）。
   *
   * 戻り値は、このConversationから新規生成・更新されたMemoryObjectの一覧
   * （Captureが実行されなかった場合は空配列）。呼び出し元は、結果を使う場合はawaitし
   * （handleEndSession/handleEndConversation）、画面遷移をブロックしたくない場合は
   * voidで発火するだけでよい（handleSwitchPersona/handleGoToTop/handleSend内の
   * 新規Conversation分岐・起動時の未Capture救済）。
   *
   * Conversation本文自体は、ここが呼ばれるより前（AI返信を受け取った直後、
   * persistConversationで毎ターン）に既に保存済みという前提のため、ここでは
   * Conversation本文の保存は行わない（persistCaptureの中でconversationも改めて
   * 書き込まれるが、内容は既に保存済みのものと同じか、Capture結果でstatus等が
   * 更新されたものになる）。
   */
  async function runConversationBoundary(target: Conversation): Promise<MemoryObject[]> {
    if (target.status === "captured" || target.turns.length === 0) {
      connectConversationBoundary(Promise.resolve([]));
      return [];
    }
    try {
      setCaptureStatus("saving");
      // 境界Captureは会話ごとに1回だけなので、このConversation自身からの
      // 既存Memory（existingMemoryObjects）は常に空でよい（前のターンでのCaptureが
      // 無いため、このConversation発の既存Memoryはまだ存在しない）。
      const { conversation: capturedDelta, memoryObjects: touchedMemoryObjects } = await captureConversation(
        target,
        []
      );
      const { conversationFailed, failedMemoryIds } = await persistCapture(
        vaultHandle,
        capturedDelta,
        touchedMemoryObjects
      );
      // 保存に成功したMemoryだけを以降の処理へ進める。IndexedDB書き込み自体が
      // 失敗したMemoryは、成功した他のMemoryを巻き込まないようここで除外する。
      const persistedMemoryObjects = touchedMemoryObjects.filter(
        (memory) => !failedMemoryIds.includes(memory.id)
      );

      // このCaptureが対象にしていたConversationが、実行中に既に別のConversationへ
      // 切り替わっていた場合（fire-and-forget呼び出し元で、切り替え自体は同期的に
      // 先に進むケース）は、古い結果を今のstateへ書き戻さない（別会話の汚染防止）。
      if (latestConversationRef.current.id === capturedDelta.id) {
        const merged: Conversation = {
          ...latestConversationRef.current,
          status: capturedDelta.status,
          memoryObjectIds: capturedDelta.memoryObjectIds.filter((id) => !failedMemoryIds.includes(id)),
          updatedAt: capturedDelta.updatedAt,
        };
        latestConversationRef.current = merged;
        setConversation(merged);
      }
      setMemoryObjects((prev) => {
        const touchedIds = new Set(persistedMemoryObjects.map((memory) => memory.id));
        return [...prev.filter((memory) => !touchedIds.has(memory.id)), ...persistedMemoryObjects];
      });

      if (conversationFailed || failedMemoryIds.length > 0) {
        console.error("Partial capture failure", { conversationFailed, failedMemoryIds });
        setCaptureStatus("partial");
      } else {
        setCaptureStatus("saved");
        window.setTimeout(() => setCaptureStatus("idle"), 2500);
      }

      enqueueRevisitPromptGeneration(persistedMemoryObjects);
      connectConversationBoundary(Promise.resolve(persistedMemoryObjects));
      return persistedMemoryObjects;
    } catch (error) {
      console.error("Failed to capture memory at conversation boundary", error);
      setCaptureStatus("error");
      connectConversationBoundary(Promise.resolve([]));
      return [];
    }
  }

  const refreshKeyStatus = () => {
    Promise.all([loadApiKey("gemini"), loadApiKey("openai")]).then(([gemini, openai]) => {
      setKeyStatusByProvider({ gemini: !!gemini, openai: !!openai });
    });
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadChatProvider(), loadApiKey("gemini"), loadApiKey("openai")]).then(
      ([savedChatProvider, gemini, openai]) => {
        if (cancelled) return;
        // chatProviderが"claude"で保存されている状況は現状発生し得ないが、
        // UIが扱えるのはgemini/openaiだけなのでgeminiへ安全側にフォールバックする。
        setChatProvider(savedChatProvider === "openai" ? "openai" : "gemini");
        setKeyStatusByProvider({ gemini: !!gemini, openai: !!openai });
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSelectChatProvider(next: SupportedChatProvider) {
    if (next === "openai" && !keyStatusByProvider.openai) return;
    setChatProvider(next);
    void saveChatProvider(next);
  }

  /**
   * Beta「過去からの問いかけ」。マウント後に1回だけバックグラウンドで生成する。
   * トップ画面自体は先に表示済みのため、ここは非ブロッキングで良い
   * （生成が終わるまで日記/探究/相談・創造の3入口は普通に使える）。
   */
  useEffect(() => {
    if (topPromptRanRef.current) return;
    topPromptRanRef.current = true;
    let cancelled = false;
    generateTopPrompt().then((result) => {
      if (cancelled || !result) return;
      setTopPrompt(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * STORAGE.md §2.4 Rebuildability Guarantee。Vault接続直後（初回接続・変更どちらも、
   * および起動時の自動再接続）に、IndexedDBがまだ知らない記憶がVault側のMarkdownに
   * 存在するかを確認する。見つかっても自動では復元しない（ユーザーの確認を挟む）。
   */
  async function checkForRestoreCandidate(handle: FileSystemDirectoryHandle) {
    try {
      const scan = await scanVaultForRestore(handle);
      const [existingConversations, existingMemoryObjects, existingSources] = await Promise.all([
        getAllConversations(),
        getAllMemoryObjects(),
        getAllSources(),
      ]);
      const existingIds = new Set([
        ...existingConversations.map((c) => c.id),
        ...existingMemoryObjects.map((m) => m.id),
        ...existingSources.map((s) => s.id),
      ]);
      const newCount =
        scan.conversations.filter((c) => !existingIds.has(c.id)).length +
        scan.memoryObjects.filter((m) => !existingIds.has(m.id)).length +
        scan.sources.filter((s) => !existingIds.has(s.id)).length;

      if (newCount > 0) {
        setRestoreCandidate({ scan, newCount });
        setRestoreStatus("idle");
      }
    } catch (error) {
      console.error("Failed to scan vault for restore", error);
    }
  }

  useEffect(() => {
    let cancelled = false;
    restoreVaultHandle().then(async (result) => {
      if (cancelled) return;
      if (result.status === "connected") {
        setVaultHandle(result.handle);
        setVaultStatus("connected");

        // Test 34：STORAGE.md §2.4 Rebuildability Guarantee。起動時にすでにVaultへの
        // 接続許可（restoreVaultHandle）が確認できている場合、handleConnectVault()と
        // 同じ手順（flush→scan）で復元候補チェックも行う。restoreVaultHandle()は
        // queryPermissionのみでrequestPermissionを呼ばない設計のため、ここに来た時点で
        // ユーザー操作なしに安全にflush/scanを実行できる。flushPendingToVault()を省略
        // すると、IndexedDB側にまだVaultへ書き戻されていない変更がある場合に、古い
        // Markdownの内容でIndexedDBを上書きしてしまう恐れがあるため必ず先に実行する。
        // 復元候補が見つかっても、この場では書き込まない。既存の確認UI・
        // handleRestoreFromVault()を経由したユーザー確認を必ず挟む（大量のMemoryを
        // 起動時に無言で上書きしない）。
        try {
          await flushPendingToVault(result.handle);
          if (cancelled) return;
          await checkForRestoreCandidate(result.handle);
        } catch (error) {
          console.error("Failed to check for restore candidates on startup", error);
        }
      } else if (result.status === "needs-permission") {
        // Android等：以前選択したフォルダのFileSystemDirectoryHandle自体はIndexedDBに
        // 有効なまま残っているが、ブラウザ管理の書き込み許可がリロードで失効している状態。
        // ここではrequestPermission()を呼ばない（ユーザー操作を伴わないmount effectの
        // ため呼べない）。handleは保持しつつ、UI側で「アクセスを再許可」ボタンを出し、
        // ユーザーのクリック（handleReauthorizeVault）を起点に再許可を試みる。
        setVaultHandle(result.handle);
        setVaultStatus("needs-permission");
      } else {
        setVaultStatus(isVaultSupported() ? "not-connected" : "unsupported");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * ROADMAP.md Phase 2「Connect」。セッション終了ボタンを押さずにブラウザを閉じた場合の
   * 救済（未Connect Memoryのキャッチアップ）。アプリ起動のたびに一度だけ、
   * まだConnectを試みていないMemoryを古い順に最大STARTUP_CONNECT_LIMIT件だけ
   * バックグラウンドで処理する。チャット操作はブロックしない。
   */
  useEffect(() => {
    if (vaultStatus === "checking" || startupConnectRanRef.current) return;
    startupConnectRanRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const allMemories = await getAllMemoryObjects();
        const unconnected = await filterUnconnected(allMemories);
        const pending = [...unconnected]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, STARTUP_CONNECT_LIMIT);
        for (const memory of pending) {
          if (cancelled) return;
          await connectMemory(vaultHandle, memory);
        }
      } catch (error) {
        console.error("Failed to run startup connect catch-up", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultStatus, vaultHandle]);

  /**
   * 未Capture Conversationのキャッチアップ。上のstartup connect catch-upと全く同じ
   * パターン（アプリ起動のたびに一度だけ、対象を古い順に少数だけバックグラウンドで
   * 処理する。チャット操作はブロックしない）を、Connectの代わりにCaptureに適用したもの。
   *
   * 「明示的な終了操作（本日はここまで／この会話を終える）をせずブラウザ・タブ・PWAを
   * 閉じた場合、そのConversationは今回の再設計で毎ターンCaptureをやめたことにより、
   * Memory生成（Capture）が一度も行われないまま残る」という状況への救済。Conversation
   * 本文自体はAI返信のたびにpersistConversationで既に保存済みのため失われないが、
   * Memory（要約・キーワード）はまだ無い状態になる。
   *
   * 「Captureを試みたかどうか」は、connectStateのような別の状態管理を新設せず、
   * Conversation自身が持つ既存のstatusフィールド（"active"＝未Capture、"captured"＝
   * 済み）だけで判定する（新しいクレーム機構は作らない）。
   */
  useEffect(() => {
    if (vaultStatus === "checking" || startupCaptureRanRef.current) return;
    startupCaptureRanRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const allConversations = await getAllConversations();
        const uncaptured = allConversations
          .filter((conversationRecord) => conversationRecord.status === "active" && conversationRecord.turns.length > 0)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
          .slice(0, STARTUP_CAPTURE_LIMIT);
        for (const conversationRecord of uncaptured) {
          if (cancelled) return;
          await runConversationBoundary(conversationRecord);
        }
      } catch (error) {
        console.error("Failed to run startup capture catch-up", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultStatus, vaultHandle, runConversationBoundary]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation.turns.length, streamingText]);

  /*
    メインチャット入力欄の自動リサイズ処理（旧: `[input]`依存のuseEffect、
    iPad Chrome向けの強制リフロー削減最適化を含む）は、`input` state自体とともに
    下部で定義する`ChatInput`コンポーネント側へ移動した。理由・詳細はChatInputの
    コメントを参照。処理内容そのものは変更していない。
  */

  useEffect(() => {
    const el = topPromptTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [topPromptInput]);

  /**
   * スマホでのソフトウェアキーボード表示検知。window.innerHeight（レイアウトビューポート）
   * とvisualViewport.height（実際に見えている領域）の差が一定以上ならキーボード表示中と
   * みなす。CSSの`sm:`ブレークポイント（幅ベース）では区別できないため、高さの実測に
   * 依存するJS側の検知が必要（詳細は調査報告のとおり）。
   *
   * KEYBOARD_HEIGHT_THRESHOLD_PXは、iOS Safariのツールバー表示/非表示や、ブラウザの
   * アドレスバー収縮といった「キーボードではない」高さ変化（数十px程度）を誤検知しない
   * ための余裕を持たせた値。実際のソフトウェアキーボードは通常200px以上あるため、
   * 150pxを閾値にする。
   *
   * ちらつき対策：判定結果（true/false）が実際に変わったときだけsetStateする
   * （resizeイベント自体はキーボードのアニメーション中に何度も発火しうるが、
   * 真偽値が変化しない限り再レンダリングは発生しない）。
   */
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const KEYBOARD_HEIGHT_THRESHOLD_PX = 150;

    function handleViewportResize() {
      const heightDiff = window.innerHeight - vv.height;
      const isKeyboardVisible = heightDiff > KEYBOARD_HEIGHT_THRESHOLD_PX;
      setKeyboardVisible((prev) => (prev === isKeyboardVisible ? prev : isKeyboardVisible));
    }

    handleViewportResize();
    vv.addEventListener("resize", handleViewportResize);
    return () => vv.removeEventListener("resize", handleViewportResize);
  }, []);

  async function handleDeleteApiKey(deleteTarget: SupportedChatProvider) {
    // Beta：Geminiキーを削除してもTsumugi提供のサーバー側キーへ自動フォールバックする
    // ため、以前のようにオンボーディング（全画面）へ戻す必要はない。
    await clearApiKey(deleteTarget);
    refreshKeyStatus();
    if (chatProvider === deleteTarget) {
      handleSelectChatProvider("gemini");
    }
  }

  async function handleConnectVault() {
    setVaultConnectFeedback(null);
    try {
      const handle = await chooseVaultDirectory();
      setVaultHandle(handle);
      setVaultStatus("connected");
      // 新しいVaultフォルダを選択した場合のみクリアする（同じVaultへの再認可＝
      // handleReauthorizeVaultでは呼ばない）。Vault同期済み台帳はどのフォルダに対する
      // 同期状況かを区別しないため、フォルダが変わったのにクリアしないと、
      // 新フォルダには実際は書き込まれていないデータを「同期済み」と誤判定し、
      // flushPendingToVaultがそのitemの書き込みをスキップしてしまう（データ消失事故）。
      await clearVaultSyncState();
      await flushPendingToVault(handle);
      await checkForRestoreCandidate(handle);
    } catch (error) {
      const feedback: VaultConnectFeedback =
        error instanceof DOMException && error.name === "AbortError"
          ? { kind: "cancelled", message: "Vault接続をキャンセルしました。" }
          : { kind: "error", message: "Vaultに接続できませんでした。" };
      if (feedback.kind === "error") {
        console.error("Failed to connect vault", error);
      }
      setVaultConnectFeedback(feedback);
      window.setTimeout(() => setVaultConnectFeedback(null), 4000);
    }
  }

  /**
   * Android等、`restoreVaultHandle()`が"needs-permission"を返した状態
   * （＝以前選択したフォルダのFileSystemDirectoryHandleはIndexedDBに残っているが、
   * ブラウザ管理の書き込み許可がリロードで失効している）から、ユーザーの明示的な
   * クリック（このボタン自体がユーザー操作＝ジェスチャーとなる）を起点に、
   * 同じhandleへrequestPermission()で再許可を求める。
   *
   * 新しいshowDirectoryPicker()は一切呼ばない（＝別フォルダの選び直しにはならない）。
   * 許可が下りなかった場合も、handle・IndexedDBのデータには一切触れず、
   * vaultStatusを"needs-permission"のまま維持し、いつでも再試行できるようにする。
   */
  async function handleReauthorizeVault() {
    if (!vaultHandle) return;
    setVaultConnectFeedback(null);
    try {
      const granted = await requestVaultPermission(vaultHandle);
      if (!granted) {
        setVaultConnectFeedback({ kind: "cancelled", message: "アクセスを許可できませんでした。" });
        window.setTimeout(() => setVaultConnectFeedback(null), 4000);
        return;
      }
      setVaultStatus("connected");
      await flushPendingToVault(vaultHandle);
      await checkForRestoreCandidate(vaultHandle);
    } catch (error) {
      console.error("Failed to reauthorize vault", error);
      setVaultConnectFeedback({ kind: "error", message: "アクセスを再許可できませんでした。" });
      window.setTimeout(() => setVaultConnectFeedback(null), 4000);
    }
  }

  async function handleRestoreFromVault() {
    if (!restoreCandidate) return;
    setRestoreStatus("restoring");
    try {
      for (const restoredConversation of restoreCandidate.scan.conversations) {
        await putConversation(restoredConversation);
      }
      for (const restoredMemoryObject of restoreCandidate.scan.memoryObjects) {
        await putMemoryObject(restoredMemoryObject);
      }
      // Test 34：Conversation/MemoryObjectと同じ扱いで、Vaultにしか存在しないSourceも
      // 復元する（従来はscan.sourcesが読み取られるだけで復元されずに失われていた）。
      for (const restoredSource of restoreCandidate.scan.sources) {
        await saveSource(restoredSource);
      }
      setRestoreStatus("done");
      setRestoreCandidate(null);
    } catch (error) {
      console.error("Failed to restore from vault", error);
      setRestoreStatus("idle");
    }
  }

  /**
   * 「Markdownをエクスポート」（データ管理機能・iPhone/iPad等のOPFSバックエンドのみ）。
   * PC/AndroidのFile System Access API Vaultは、ユーザーが選んだ実フォルダを
   * Finder/エクスプローラーから直接読み書きできるため、この機能自体をSettingsPanel側で
   * 表示しない（vaultBackend === "opfs"の場合だけ呼ばれる想定。この関数自体もそれを
   * 前提にガードする）。
   *
   * Vault内の全Markdownを集めてZIPへまとめ、iOS/iPadOS Web環境で実際に動作する
   * 経路（Web Share API→ファイル共有、対応していなければ<a download>）で端末外へ
   * 出せるようにする。「安全な領域」から直接どこかへ移動する必要はなく、あくまで
   * ユーザー自身がOSの共有・保存UIを使って選んだ先へコピーを渡すだけ。
   */
  async function handleExportData() {
    if (vaultBackend !== "opfs" || !vaultHandle) return;
    setExportDataFeedback({ kind: "busy", message: "エクスポートを準備しています…" });
    try {
      const files = await collectAllMarkdownFiles(vaultHandle);
      if (files.length === 0) {
        setExportDataFeedback({ kind: "empty", message: "エクスポートするデータがありません。" });
        window.setTimeout(() => setExportDataFeedback(null), 4000);
        return;
      }

      const blob = createZipBlob(files);
      const fileName = `tsumugi-export-${new Date().toISOString().slice(0, 10)}.zip`;
      const zipFile = new File([blob], fileName, { type: "application/zip" });

      let shared = false;
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [zipFile] })) {
        try {
          await navigator.share({ files: [zipFile], title: "tsumugiのMarkdownエクスポート" });
          shared = true;
        } catch (shareError) {
          if (shareError instanceof DOMException && shareError.name === "AbortError") {
            // ユーザーが共有シートをキャンセルしただけなので、エラーとしては扱わない。
            setExportDataFeedback(null);
            return;
          }
          // 共有自体に失敗した場合は、下のダウンロードへフォールバックする。
        }
      }

      if (!shared) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      setExportDataFeedback({ kind: "success", message: "エクスポートしました。" });
      window.setTimeout(() => setExportDataFeedback(null), 4000);
    } catch (error) {
      console.error("Failed to export data", error);
      setExportDataFeedback({ kind: "error", message: "データのエクスポートに失敗しました。" });
      window.setTimeout(() => setExportDataFeedback(null), 4000);
    }
  }

  /**
   * 「この端末に保存されているデータを削除」（データ管理機能・OPFSバックエンドのみ）。
   * 削除するのはtsumugiが自分で作成・管理しているデータだけ：
   *   - OPFS Vault本体（Conversations/Memories/Sources等のMarkdown一式）
   *   - IndexedDBの派生キャッシュ（conversations/memoryObjects/sources/connectState）
   * ブラウザ全体のデータ・他アプリのデータ・OSのストレージ・PC/Androidのユーザー選択
   * Vault・APIキー等の設定（settings）・Vaultフォルダの参照（handles）には一切触れない
   * （clearOpfsVault/clearMemoryDataそれぞれのコメント参照）。
   *
   * 実行前に必ずwindow.confirm()で明示的な確認を挟み、キャンセルされた場合は何もしない。
   * 削除に成功したら、Vault・IndexedDB双方から復元されるはずの古いstate（会話・Memory等）
   * が画面に残り続けないよう、ページごとリロードする。
   */
  async function handleDeleteData() {
    if (vaultBackend !== "opfs" || !vaultHandle) return;
    const confirmed = window.confirm(
      "この端末に保存されているtsumugiのデータを削除します。\nこの操作は元に戻せません。\n本当に削除しますか？"
    );
    if (!confirmed) return;

    setDeleteDataFeedback({ kind: "busy", message: "削除しています…" });
    try {
      await clearOpfsVault(vaultHandle);
      await clearMemoryData();
      window.location.reload();
    } catch (error) {
      console.error("Failed to delete data", error);
      setDeleteDataFeedback({ kind: "error", message: "データの削除に失敗しました。" });
      window.setTimeout(() => setDeleteDataFeedback(null), 4000);
    }
  }

  /**
   * 「本日はここまで」。UI_UX.md「Users never press Save」の"Save"ではない
   * （保存は既にCaptureが自動で行っている）。あくまで任意の締めくくりの操作。
   * 既存のCaptureは呼ばない。既存のmemoryObjectを材料に、別のinsight MemoryObjectを1つ作る。
   *
   * 順序について（handleEndConversationとの違い）：handleEndConversationとは異なり、
   * ここではendedAtをCaptureより先に確定させない。conversation.endedAtは、
   * Reflection生成（/api/reflect）・insight Memoryの保存まで全て成功した最後の時点
   * （下記）でのみセットする。理由：Reflectionが失敗した場合（reflectionStatus==="error"）
   * でも会話を「未終了」のまま残し、ユーザーが同じ会話に対してもう一度「本日はここまで」を
   * 押して再試行できるようにするため。もしendedAtを先に確定させてしまうと、Reflection失敗時に
   * 「終了したのに振り返りが無い」という中途半端な状態になり、再試行の手段も無くなる。
   * Conversation本文自体（会話のターン）はendedAtの有無に関わらずAI返信のたびに既に
   * persistConversationで保存済みのため、この順序でもConversation本文が失われることはない。
   */
  async function handleEndSession() {
    // UI改善：ボタン押下の直後、Boundary Captureの解決を待つ前から状態を表示する。
    setReflectionStatus("capturing");
    // Conversation Boundary（このConversationの唯一のCapture機会）をここで実行する。
    // 会話中は毎ターンCaptureしていないため、ここで初めて/api/captureが呼ばれる
    // （runConversationBoundaryが内部でMemory保存・Connectまで完了させる）。
    const latestMemoryObjects = await runConversationBoundary(latestConversationRef.current);

    if (latestMemoryObjects.length === 0) {
      // Captureがまだ一度も成功していない（進行中 or 失敗）。
      // 無反応にはせず、ユーザーに次にどうすればよいか分かる状態にする。
      setReflectionStatus("unavailable");
      return;
    }

    setReflectionStatus("generating");
    try {
      // 振り返り（/api/reflect）はMemoryObjectを1件受け取る既存の設計のため、
      // 今回のConversationから生まれた複数Memoryを1つにまとめた材料として渡す
      // （reflection.ts / /api/reflect側は変更しない）。
      const reflectionSource: MemoryObject = {
        ...latestMemoryObjects[0],
        summary: latestMemoryObjects.map((memory) => memory.summary).join(" / "),
        content: latestMemoryObjects.map((memory) => memory.content).join("\n\n"),
        keywords: [...new Set(latestMemoryObjects.flatMap((memory) => memory.keywords))],
      };

      const text = await generateSessionReflection(persona, reflectionSource);
      const insightMemory = createInsightMemoryObject(conversation, reflectionSource, text);
      const endedConversation: Conversation = {
        ...conversation,
        endedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        memoryObjectIds: [...conversation.memoryObjectIds, insightMemory.id],
      };

      // 既存のwriteConversationMarkdown / writeMemoryObjectMarkdown / putConversation / putMemoryObjectを
      // そのまま再利用する（persistCaptureは会話1件+MemoryObject複数件を書き出す処理として、
      // Capture専用ではなくそのまま使い回せる）。
      const { failedMemoryIds: reflectionFailedIds } = await persistCapture(vaultHandle, endedConversation, [
        insightMemory,
      ]);
      if (reflectionFailedIds.length > 0) {
        // insight MemoryのIndexedDB保存自体が失敗した場合は、Reflectionを「完了」として
        // 表示しない（黙って失われた記憶を「保存できた」と伝えないため）。
        console.error("Reflection insight memory failed to persist", reflectionFailedIds);
        setReflectionStatus("error");
        return;
      }

      setConversation(endedConversation);
      latestConversationRef.current = endedConversation;
      setReflectionText(text);
      setReflectionStatus("done");

      // Connect（ROADMAP.md Phase 2）。latestMemoryObjects分は既にrunConversationBoundary内で
      // Connect済みのため、ここではこのReflection自体（insightMemory）だけを追加でConnectする。
      // Reflection表示をブロックしないよう非同期で走らせる（connectConversationBoundaryを
      // そのまま再利用。失敗してもReflection自体は成功しているためreflectionStatusには
      // 影響させない。未Connectのまま残っても次回起動時のキャッチアップで再試行される）。
      connectConversationBoundary(Promise.resolve([insightMemory]));
    } catch (error) {
      console.error("Failed to generate session reflection", error);
      setReflectionStatus("error");
    }
  }

  /**
   * 「この会話を終える」。「今日はここまで」（handleEndSession、日記＝persona==="companion"
   * 専用、AIに1日の振り返り文＝insight MemoryObjectを新しく生成させる重い処理）とは別の、
   * 「会話」（companion以外のpersona）向けの軽量な区切り操作。
   *
   * これは「保存」ボタンではない。Conversation本文はAI返信のたびに既に
   * persistConversationで保存され続けている。ここで新たに行うのは次の2つだけ：
   *   1. conversation.endedAtをセットして、このConversationに区切りをつける
   *      （handleSend()の「endedAtが立っている会話には追記せず新規作成する」分岐が
   *      既に存在するため、これだけで「次に話しかけたら新しい会話になる」が成立する。
   *      新しいstate・新しい判定ロジックは増やさない）。
   *   2. Conversation Boundaryとして、まだCaptureされていなければここでCaptureする
   *      （runConversationBoundary。会話中は毎ターンCaptureしていないため、多くの場合
   *      ここが唯一のCapture機会になる）。
   * 新しいMemoryObjectは作らない（handleEndSessionのinsight生成とは異なる）。
   *
   * 順序について（Conversation保存とCapture/Memory生成の責務分離）：endedAt付き
   * Conversationの保存を、Captureより先に行う。これにより、直後のCapture
   * （AI呼び出し）が失敗したりブラウザが閉じられたりしても、会話が「終了した」
   * 状態のままConversation本文自体は確実に保存されている状態を作る。ただし、
   * 画面上でボタンが消える（conversation state更新）タイミングはCapture完了後まで
   * 据え置く（UI改善。処理中にボタンだけ消えて結果が出るまで空白になる問題への対策）。
   *
   * 会話境界からの離脱という点でhandleSwitchPersona/handleGoToTop/handleSend内の
   * 終了済み会話からの新規開始と同じ性質を持つため、同様にrunConversationBoundary()
   * を呼ぶ（Capture・Connect自体の実装には一切触れない）。
   */
  async function handleEndConversation() {
    setEndingConversation(true);
    try {
      const endedConversation: Conversation = {
        ...latestConversationRef.current,
        endedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Conversation本文（endedAt付き）をCaptureより先に保存する。これにより、
      // 直後のCapture（AI呼び出し）が失敗したりブラウザが閉じられたりしても、
      // 会話は「終了した」状態のままConversation本文自体は確実に保存されている
      // （Capture＝Memory生成の成否とは独立した保存。今回のConversation保存/Capture
      // 責務分離の目的そのもの）。
      await persistConversation(vaultHandle, endedConversation);
      // refだけ先に更新する（React stateはまだここでは更新しない）。
      // runConversationBoundaryはこのrefをCapture対象・成功時のマージ元として読むため、
      // 先にendedAt付きにしておく必要がある（そうしないと、Capture成功時に
      // runConversationBoundaryが書き戻すConversationからendedAtが消えてしまう）。
      latestConversationRef.current = endedConversation;

      // Conversation Boundary。runConversationBoundaryが内部でCapture・Memory保存・
      // Connectまで完了させる（未Captureの場合のみ実行、既にCapture済みなら何もしない）。
      const latestMemoryObjects = await runConversationBoundary(endedConversation);

      // UI改善：conversation stateへの反映（＝ボタンをJSXから消す条件）を、ここまで
      // 遅らせる。以前はendedAtの反映がCapture開始前に起きていたため、「ボタンが
      // 消えてから結果カードが出るまで」に何も表示されない空白区間が生じていた
      // （処理中なのか押せたのかエラーなのか分からない、という指摘）。
      // latestConversationRef.currentをそのまま読むことで、runConversationBoundaryが
      // Capture成功時に書き戻したstatus/memoryObjectIds等も含めて反映する。
      setConversation(latestConversationRef.current);

      setEndedConversationMemories(latestMemoryObjects);
    } catch (error) {
      console.error("Failed to end conversation", error);
    } finally {
      setEndingConversation(false);
    }
  }

  /**
   * 会話中の「日記／探究／相談・創造」。Personaを途中で切り替えるのではなく、
   * 新しいConversationを始めるボタンとして扱う（トップ画面の入口と同じPersonaを使う）。
   * 画面上は完全に新しい会話として始まり、古いConversationの内容は表示しない。
   * ただし古いConversationはこれまでのCaptureで既に随時保存済みであり、ここでは
   * IndexedDB/Vaultへの削除も上書きも行わない（React state上の参照を新しい
   * Conversationへ切り替えるだけ）。handleSend()の「終了済みConversationへは
   * 追記せず新規作成する」分岐と全く同じリセット処理を再利用する。
   */
  function handleSwitchPersona(nextPersona: Persona) {
    void runConversationBoundary(latestConversationRef.current);

    const newConversation = createConversation(nextPersona);
    setConversation(newConversation);
    latestConversationRef.current = newConversation;
    setPersona(nextPersona);
    setMemoryObjects([]);
    setEndedConversationMemories(null);
    setReflectionStatus("idle");
    setReflectionText("");
    setInputResetKey((k) => k + 1);
    setStreamingText("");
    setSendStatus("idle");
  }

  /**
   * ロゴクリックでトップ画面（ペルソナ選択前）へ戻る。handleSwitchPersona()と同じく、
   * 新しい空のConversationへReact state上の参照を切り替えるだけで、既存のConversation/
   * MemoryObjectはIndexedDB/Vaultとも一切削除・上書きしない。ページリロードも行わない。
   * personaはまだ選び直されていないため、既存stateの値をそのままcreateConversation()に
   * 渡す（トップ画面自体はこの値を表示に使わない）。
   */
  function handleGoToTop() {
    void runConversationBoundary(latestConversationRef.current);

    const newConversation = createConversation(persona);
    setConversation(newConversation);
    latestConversationRef.current = newConversation;
    setMemoryObjects([]);
    setEndedConversationMemories(null);
    setReflectionStatus("idle");
    setReflectionText("");
    setInputResetKey((k) => k + 1);
    setStreamingText("");
    setSendStatus("idle");
    setEntryConfirmed(false);
  }

  /**
   * overrideTextが渡された場合はinput stateではなくそちらを送信する（過去からの問いかけ用）。
   * overridePersonaも同様。personaは closure変数のため、呼び出し元がsetPersona()した直後に
   * 再レンダーを挟まず本関数を呼ぶケース（過去からの問いかけ）では、closure変数のpersonaは
   * まだ更新前の値のままになる（baseConversationをlatestConversationRefから読む理由と同じ）。
   * メインの入力欄（ChatInput）は常にoverrideTextを渡して呼ぶため、ここで`input`状態を
   * 読む必要はない（`input`自体がもうChatScreenには存在しない。ChatInputが送信成功後に
   * 自分のローカルstateをクリアする）。
   */
  async function handleSend(overrideText?: string, overridePersona?: Persona) {
    const text = (overrideText ?? "").trim();
    if (!text || busy) return;
    const activePersona = overridePersona ?? persona;

    setBusy(true);
    setStreamingText("");
    setSendStatus("idle");
    startWaiting();

    // 「本日はここまで」で終了済みのConversationへは追記しない。
    // ページ再読み込みを挟まず、ここで新しいConversationを開始する
    // （Conversationは会話の文脈の単位であり、話題ごとのMemory分割とは別の話）。
    // conversation（closure変数）ではなくlatestConversationRefを読む。
    // 「過去からの問いかけ」ではhandleTopPromptSend()がsetConversationした直後、
    // 再レンダーを挟まずこの関数を呼ぶため、closure変数のconversationはまだ古い値のまま
    // （問いかけ自体のturnが乗っていない）参照してしまう。
    let baseConversation = latestConversationRef.current;
    if (baseConversation.endedAt) {
      void runConversationBoundary(baseConversation);

      baseConversation = createConversation(activePersona);
      setConversation(baseConversation);
      latestConversationRef.current = baseConversation;
      setMemoryObjects([]);
      setEndedConversationMemories(null);
      setReflectionStatus("idle");
      setReflectionText("");
    }

    const userTurn: ConversationTurn = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    let updated = appendTurn(baseConversation, userTurn);
    setConversation(updated);
    latestConversationRef.current = updated;

    try {
      // Retrieval Engine（ローカルのみ・AIを呼ばない）。毎ターン実行し、
      // 使うかどうかの判断は/api/chat側のAIに委ねる（0件ならそのまま0件で渡す）。
      // 明示的Reflection（ROADMAP.md Phase 2）：ローカル判定のみでlimitとLink経由上限を広げる。
      // 判定がfalseの場合は既定のまま、Phase 1からの挙動を完全に維持する。
      const reflective = isReflectiveQuery(text);
      const retrievedMemories = await retrieveRelevantMemories(text, {
        excludeConversationId: baseConversation.id,
        limit: reflective ? REFLECTIVE_LIMIT : undefined,
        maxLinkedAdditions: reflective ? REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
        persona: activePersona,
        promptedMemoryId: baseConversation.promptedMemoryId,
      });

      // chatだけは選択中provider（既定Gemini）を使う。他機能（Capture/Connect/Reflection/
      // 問いかけ生成）はloadApiKey()を引数なしで呼ぶため、常にGeminiのままである。
      const storedApiKey = await loadApiKey(chatProvider);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AI_PROVIDER_HEADER]: chatProvider,
          ...(storedApiKey ? { [API_KEY_HEADER_BY_PROVIDER[chatProvider]]: storedApiKey } : {}),
        },
        body: JSON.stringify({ persona: activePersona, turns: updated.turns, retrievedMemories }),
      });

      if (!res.ok || !res.body) {
        throw new ChatRequestError(res.status);
      }

      // このAIターンの生成でWeb検索が有効化されていたか（needsWebSearch()の判定結果）。
      // 実際に検索結果が取得できた・groundingが発生したことの証明ではない。
      // ヘッダーが無い場合（旧サーバー等）は、既存Conversationとの互換性を優先してundefinedのままにする。
      const webSearchRequestedHeader = res.headers.get("X-Tsumugi-Web-Search-Requested");
      const webSearchRequested =
        webSearchRequestedHeader === null ? undefined : webSearchRequestedHeader === "true";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setStreamingText(full);
        stopWaiting();
      }

      const aiTurn: ConversationTurn = {
        role: "ai",
        content: full,
        timestamp: new Date().toISOString(),
        ...(webSearchRequested !== undefined ? { webSearchRequested } : {}),
      };
      updated = appendTurn(updated, aiTurn);
      setConversation(updated);
      latestConversationRef.current = updated;
      setStreamingText("");

      // Conversation本文の保存とMemory生成（Capture）は分離する（今回の再設計）。
      // ここではConversation本文だけを保存し、Captureの成否とは無関係に会話が
      // 必ず残るようにする。Memory生成はConversation Boundary（終了操作・persona切替・
      // トップへ戻る等）でのみrunConversationBoundaryが行う（毎ターンは呼ばない）。
      // 保存の完了を待たず、ここで次の入力を可能にする。
      setBusy(false);
      void persistConversation(vaultHandle, updated);
    } catch (error) {
      console.error("Failed to send message", error);
      setSendStatus(error instanceof ChatRequestError && error.status === 401 ? "authError" : "error");
    } finally {
      setBusy(false);
      stopWaiting();
    }
  }

  /**
   * 「過去からの問いかけ」への回答。既存のhandleSend()をそのまま再利用する
   * （新しい送信ロジックは作らない）。Personaは元Memoryが属していたConversationの
   * ものを引き継ぐ（topPrompt.persona、取得できない場合はcompanionにfallback。
   * topPrompt.ts側で解決済み）。
   *
   * 画面に表示した問いかけ文を、送信前にconversation.turnsへassistant発言として
   * 追加しておく。これをしないと、Gemini側には「ユーザーの回答」だけが渡り、
   * 自分が直前に何を尋ねたのか分からないまま返答することになる
   * （実際に「あまり進んでいない」→「何が進んでいないのでしょうか」という
   * 文脈を無視した返答が発生していた）。
   */
  function handleTopPromptSend() {
    const text = topPromptInput.trim();
    if (!text || busy || !topPrompt) return;

    const questionTurn: ConversationTurn = {
      role: "ai",
      content: topPrompt.question,
      timestamp: new Date().toISOString(),
    };
    // promptedMemoryIdは「この会話がどのMemoryをきっかけに始まったか」の追跡用
    // （Vault Markdownへは書き出さない実行時・IndexedDBの補助情報）。
    // personaもここで明示的に上書きする。captureConversation()はconversation.personaを
    // 参照するため（トップレベルのpersona stateとは別）、両方を揃えておく必要がある。
    const updated: Conversation = {
      ...appendTurn(conversation, questionTurn),
      persona: topPrompt.persona,
      promptedMemoryId: topPrompt.memory.id,
    };
    setConversation(updated);
    latestConversationRef.current = updated;

    setEntryConfirmed(true);
    setPersona(topPrompt.persona);
    setTopPrompt(null);
    setTopPromptInput("");
    void handleSend(text, topPrompt.persona);
  }

  const showPersonaSelector = conversation.turns.length === 0;
  const showEntryScreen = showPersonaSelector && !entryConfirmed;

  /**
   * PCはFile System Access APIの実フォルダ、スマホ等はOPFS（navigator.storage.getDirectory()）に
   * 自動フォールバックする（vault.ts参照）。OPFSのルートhandleは`name`が空文字のため、
   * `vaultHandle.name`をそのまま表示するとラベルが空になる。バックエンドを判定し、
   * OPFSの場合は固定文言に差し替える。
   */
  const vaultBackend = getVaultBackend();
  const vaultStatusLabel =
    vaultStatus === "connected" && vaultHandle
      ? vaultBackend === "opfs"
        ? "この端末の安全な領域"
        : vaultHandle.name
      : vaultStatus === "needs-permission" && vaultHandle
        ? // Android等：以前の保存先フォルダは存在するが、書き込み許可がリロードで失効した状態。
          // 「この端末のみ」と表示すると接続が失われたかのように見えてしまうため、
          // 前回選択したフォルダ名を明示した上で要許可であることを示す。
          `${vaultHandle.name}（要許可）`
        : vaultStatus === "unsupported"
          ? "非対応"
          : vaultStatus === "checking"
            ? "確認中"
            : "この端末のみ";

  return (
    <div className="flex h-dvh flex-col bg-[var(--background)] text-[var(--foreground)]">
      {/*
        Phase A（Android実機キーボード入力の完全復旧）：rootのoverflowは
        f818292時点の状態（overflow制限なし）へ戻した。
        経緯：footerアイコンの`-my-3`による4pxの静的overflow対策として、一時
        `overflow-hidden`を常時（aac828f）→keyboardVisible時のみ解除（0a5ed37）
        という形で追加していたが、実機検証の結果、ソフトウェアキーボード表示時に
        Android Chromeの「フォーカスした入力欄が隠れる場合に自動でその要素が
        見えるようスクロールする」というネイティブ挙動を阻害する回帰が発生した
        （keyboardVisible判定はvisualViewportのresizeイベント後に非同期で確定するため、
        フォーカス直後にブラウザが一度だけ試みるスクロールの瞬間には、まだ
        overflow-hiddenが効いており、ネイティブスクロールが失敗する。ブラウザは
        失敗したスクロールを後から再試行しないため、入力欄がキーボードの下に
        隠れたままになっていた）。
        4px overflow問題そのものはPhase Aとは切り離し、キーボード入力の完全復旧を
        最優先として、rootのoverflow制御は撤去した。footerボタンの`-my-3`・
        keyboardVisibleの検知ロジック本体・visualViewport処理・mainの
        overflow-y-auto・padding/gap・mobile fade・ChatInputの構造は
        一切変更していない。
      */}
      {/*
        スマホでは、スクロール末尾（＝会話の最後の文章）とfooter（入力欄）の境界が
        近すぎて、文章が入力欄に隠れて見える／「Webフォーム感」が出るという指摘があった。
        入力欄自体を動かすのではなく、会話領域（main）の下端に呼吸できる余白を
        追加することで解決する：pb-8(32px)→pb-12(48px)。PCは元のpy-8のまま
        （sm:pb-8で32pxに戻す）で変更しない。キーボード表示・非表示のどちらでも
        一定の余白が効くよう、keyboardVisibleでは分岐させない（今回の追加は
        ごく小さい固定値のため、キーボード表示時の高さへの影響は軽微）。
      */}
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 overflow-y-auto px-5 pt-8 pb-12 sm:pb-8">
        {/*
          ロゴ（header）とneeds-permissionカードは、以前はroot直下・main（スクロール
          コンテナ）の外にあり、会話をスクロールしても画面上部に残り続けていた。
          「ロゴ→必要ならpermissionカード→会話」を1つの自然なスクロール領域にするため、
          両方をmainの最初の子要素としてここへ移動した。
          headerのclassNameからpx-4/pt-8を外しているのは、main自身が既にpx-5/pt-8を
          持っており、二重に効いてしまうため（main内部に入った以上、水平・上方向の
          余白はmain側のpx-5/pt-8に一本化する）。pb-3も外している：main自身のgap-6が
          flex-colの子同士（header→次の要素）の間隔を自動的に担うため、pb-3を残すと
          gap-6(24px)+pb-3(12px)の二重の余白になってしまう。結果、ロゴ下の余白は
          以前の12px（header自身のpb-3のみ）からgap-6の24pxへ変わるが、これはgap-6
          自体を変更せずmain内部へ移動したことによる自然な帰結であり、意図的な調整。
          ロゴ画像自体（img・button）のクラスは一切変更していない。
        */}
        <div className="flex items-center justify-center">
          <button
            type="button"
            onClick={handleGoToTop}
            aria-label="トップ画面へ戻る"
            className="w-[min(220px,100%)] rounded-lg"
          >
            <img
              src="/logo.png"
              alt="Tsumugi"
              className="h-auto w-full dark:invert"
            />
          </button>
        </div>

        {/*
          Android等：File System Access Vaultのhandle自体はIndexedDBに残っているが、
          readwrite許可がリロードで失効している状態（vaultStatus === "needs-permission"）。
          設定画面（⚙）まで移動しないと再許可できないと、ユーザーが「保存先を失った」と
          誤認しやすいため、トップ画面にも同じ再許可導線を出す。呼び出す処理は
          SettingsPanelと同じhandleReauthorizeVault()そのもの（新しい許可取得処理は作らない）。
          OPFS（iPadOS等）はvaultStatusが"connected"のままなのでこの条件には入らない。
          以前はmx-auto w-full max-w-2xl px-5のラッパーで自前にセンタリング・横paddingを
          持っていたが、main内部へ移動した今はmain自身が既にそれを提供しているため、
          そのラッパーを外し、カード本体のdivをそのまま返す（見た目・内容・表示条件・
          再許可ロジックは一切変更していない）。
        */}
        {vaultStatus === "needs-permission" && vaultHandle && !vaultReauthDismissed && (
          <div className="flex flex-col gap-3 rounded-xl bg-amber-50/60 px-4 py-3 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
            <div className="flex flex-col gap-1">
              <p>保存先へのアクセスが必要です</p>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                前回選択したVaultへのアクセスをもう一度許可してください。会話やMemoryを正しく保存するために必要です。
              </p>
              {vaultConnectFeedback && (
                <p className="text-xs text-stone-500 dark:text-stone-400">{vaultConnectFeedback.message}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleReauthorizeVault()}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                アクセスを再許可
              </button>
              <button
                type="button"
                onClick={() => setVaultReauthDismissed(true)}
                className="shrink-0 rounded-full px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:text-stone-400 dark:hover:bg-white/5"
              >
                あとで
              </button>
            </div>
          </div>
        )}

        {showEntryScreen ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
            {topPrompt && (
              <div className="flex w-full flex-col items-center gap-3 border-b border-black/5 pb-8 dark:border-white/10">
                <p className="whitespace-pre-wrap text-base text-stone-600 dark:text-stone-300">
                  {topPrompt.question}
                </p>
                <div className="flex w-full max-w-md items-end gap-2 rounded-2xl border border-stone-300/70 bg-white/70 p-2 shadow-sm dark:border-stone-700/70 dark:bg-stone-900/60">
                  {/*
                    Enterは常に改行（送信しない）。「送る」ボタンのみが送信手段。
                    以前このボックスがinputだった際、IME変換確定のEnterで意図せず送信される
                    問題があったため、Enterへの特別な処理自体を持たせない設計にする
                    （通常のChat入力欄＝textareaRefも同じ方針に統一済み。Enterで送信する
                    処理はどちらの入力欄にも無い）。
                  */}
                  <textarea
                    ref={topPromptTextareaRef}
                    rows={1}
                    value={topPromptInput}
                    onChange={(event) => setTopPromptInput(event.target.value)}
                    placeholder="ここに入力してください"
                    className="max-h-64 min-h-24 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm outline-none placeholder:text-stone-400"
                  />
                  <button
                    onClick={handleTopPromptSend}
                    disabled={!topPromptInput.trim()}
                    className="shrink-0 rounded-xl bg-stone-800 px-4 py-2 text-sm text-stone-50 transition disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
                  >
                    送る
                  </button>
                </div>
              </div>
            )}
            <p className="text-xl text-stone-500 dark:text-stone-400">今日は、どう話そう？</p>
            {/*
              「日記」＋「会話」の2本立て（今回のUX変更）。以前はここにPERSONASの
              3ボタン（日記／探究／相談・創造）が並んでいたが、「探求」「相談・創造」を
              ユーザー向けの別モードとして表示するのをやめ、1つの「会話」ボタンへ
              まとめる。「日記」はこれまでどおりpersona="companion"のまま独立して残す。
              「会話」はpersona="analyst"（既存の「相談・創造」の体験）を使う
              （※coach/analystのどちらを割り当てても内部ロジック上は等価。ユーザーの
              例示（相談・アイデア・整理）に近いanalystを選んだ）。
              persona自体の型・/api/chat・/api/reflectのペルソナ別プロンプト分岐・
              Retrievalの分岐・coach自体のロジックは一切削除・変更していない
              （表示上の入口を2つにまとめただけ。内部ロジックは現状維持）。
              「過去からの問いかけ」経由（handleTopPromptSend）や、その会話が終わった
              後の継続選択（下記、promptedMemoryId起点の3ボタン）は、この変更の対象外
              として従来どおり残している（会話境界を大きく作り直さないため）。
            */}
            <div className="flex flex-wrap justify-center gap-3">
              <button
                onClick={() => {
                  setPersona("companion");
                  setEntryConfirmed(true);
                }}
                className="rounded-2xl border border-stone-300/70 px-7 py-5 text-center text-base text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-100 dark:hover:border-stone-400 dark:hover:bg-stone-900"
              >
                日記
              </button>
              <button
                onClick={() => {
                  setPersona("analyst");
                  setEntryConfirmed(true);
                }}
                className="rounded-2xl border border-stone-300/70 px-7 py-5 text-center text-base text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-100 dark:hover:border-stone-400 dark:hover:bg-stone-900"
              >
                会話
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1 text-stone-500 dark:text-stone-400">
              <p className="text-lg">{greeting}</p>
              <p className="text-lg">
                {PERSONAS.find((p) => p.value === persona)?.openingMessage ?? "今日はどんな一日でしたか？"}
              </p>
            </div>

            {conversation.turns.map((turn, index) => (
              <TurnBubble key={index} turn={turn} />
            ))}

            {busy && streamingText && (
              <TurnBubble turn={{ role: "ai", content: streamingText, timestamp: "" }} />
            )}

            {busy && !streamingText && waitingMessage && (
              <p className="text-sm text-stone-400 dark:text-stone-500">{waitingMessage}</p>
            )}
          </>
        )}

        {/*
          終了アクションはpersonaで出し分ける（今回のUX変更）。
          - persona==="companion"（＝日記）：これまでどおり「本日はここまで」
            （handleEndSession。AIが1日の振り返り＝insight MemoryObjectを新しく生成する）。
          - persona!=="companion"（＝それ以外、UI上はすべて「会話」として扱う）：
            新しい「この会話を終える」（handleEndConversation。振り返り生成はせず、
            conversation.endedAtで区切りをつけ、今回のMemoryを確認できるようにするだけ）。
          会話中に常時表示していた「記憶しました」カードは撤去した（Capture自体・
          IndexedDB/Vaultへの保存は変更なくバックグラウンドで継続する。表示だけをやめた）。
        */}
        {persona === "companion" &&
          conversation.turns[conversation.turns.length - 1]?.role === "ai" &&
          !conversation.endedAt && (
          <div className="flex flex-col items-center gap-2 pt-4 text-center">
            <button
              onClick={() => void handleEndSession()}
              disabled={reflectionStatus === "capturing" || reflectionStatus === "generating"}
              className="text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600 disabled:opacity-50 dark:text-stone-500 dark:decoration-stone-700 dark:hover:text-stone-300"
            >
              本日はここまで
            </button>
            {/*
              UI改善（速度改善ではない）：以前はreflectionStatus==="generating"の区間
              （＝runConversationBoundaryの解決後、/api/reflect呼び出し中）だけにテキストを
              出していたため、ボタン押下からcapture待ちが終わるまでの数秒間、画面が完全に
              無反応に見えていた。"capturing"を追加し、ボタン押下の直後から何かしらの文言を
              出し続けるようにした。文言は段階で変える：capture待ち中は
              「記憶を確認しています…」（実際に振り返りをまだ生成していないため）、
              /api/reflect呼び出し中だけ「今日を振り返っています…」のまま。
            */}
            {reflectionStatus === "capturing" && (
              <p className="text-xs text-stone-400 dark:text-stone-500">記憶を確認しています…</p>
            )}
            {reflectionStatus === "generating" && (
              <p className="text-xs text-stone-400 dark:text-stone-500">今日を振り返っています…</p>
            )}
            {reflectionStatus === "error" && (
              <p className="text-xs text-red-600 dark:text-red-400">振り返りの生成に失敗しました。</p>
            )}
            {reflectionStatus === "unavailable" && (
              <p className="text-xs text-stone-400 dark:text-stone-500">
                まだ記憶として保存できていないようです。少し待ってからもう一度お試しください。
              </p>
            )}
          </div>
        )}

        {persona !== "companion" &&
          conversation.turns[conversation.turns.length - 1]?.role === "ai" &&
          !conversation.endedAt && (
          <div className="flex flex-col items-center gap-2 pt-4 text-center">
            <button
              onClick={() => void handleEndConversation()}
              disabled={endingConversation}
              className="text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600 disabled:opacity-50 dark:text-stone-500 dark:decoration-stone-700 dark:hover:text-stone-300"
            >
              この会話を終える
            </button>
            {/*
              UI改善（速度改善ではない）：以前はendingConversation中でもボタン自体は
              disabledになるだけでテキストが無く、その後endedAtが確定した瞬間にボタンが
              DOMから消え、結果カードが出るまでの間「何も無い」空白区間があった
              （処理中／押せた／エラーか分からない、という指摘）。ボタンが消えるタイミングを
              persistCapture成功後まで遅らせた上で、処理中はこのテキストを表示する。
            */}
            {endingConversation && (
              <p className="text-xs text-stone-400 dark:text-stone-500">終えています…</p>
            )}
          </div>
        )}

        {reflectionStatus === "done" && (
          <div className="rounded-2xl border border-stone-300/60 bg-stone-100/60 px-5 py-4 dark:border-stone-700/60 dark:bg-stone-900/40">
            <p className="mb-2 text-xs text-stone-400 dark:text-stone-500">今日の振り返り</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
              {reflectionText}
            </p>
          </div>
        )}

        {/*
          「この会話を終える」を押した直後だけ表示する結果カード。endedConversationMemoriesは
          null＝会話中（非表示）、配列＝ちょうど終えた直後（0件を含む）。0件の場合に
          「記憶しました」と偽らないよう、有無で文言ごと出し分ける（3.の要件）。
        */}
        {endedConversationMemories !== null && (
          <div className="flex flex-col gap-2 rounded-2xl border border-stone-300/60 bg-stone-100/60 px-4 py-3 text-sm dark:border-stone-700/60 dark:bg-stone-900/40">
            {endedConversationMemories.length > 0 ? (
              <>
                <p className="text-stone-500 dark:text-stone-400">ここまでを記憶しました。</p>
                <ul className="flex flex-col gap-1 text-stone-700 dark:text-stone-300">
                  {endedConversationMemories.slice(0, 3).map((memory) => (
                    <li key={memory.id}>・{memory.summary}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => {
                    setHistoryInitialMemoryId(endedConversationMemories[0]?.id);
                    setHistoryOpen(true);
                  }}
                  className="self-start text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600 dark:text-stone-500 dark:decoration-stone-700 dark:hover:text-stone-300"
                >
                  詳細を見る
                </button>
              </>
            ) : (
              <p className="text-stone-500 dark:text-stone-400">今回は新しく記憶したことはありませんでした。</p>
            )}
          </div>
        )}

        {/*
          この3ボタンは「Personaを切り替えるナビゲーション」ではなく、過去からの問いかけ
          （revisitPrompt）をきっかけに始まったConversationからだけ出す入口。判定は
          turnsの文字列内容からの推測ではなく、Conversation生成時に明示的に立てる
          promptedMemoryId（handleTopPromptSendが設定、通常のPersona選択や
          handleSwitchPersonaが作るConversationには付かない）で行う。
        */}
        {!showEntryScreen && !busy && conversation.turns.length > 0 && !!conversation.promptedMemoryId && (
          <div className="flex flex-col items-center gap-3 pt-6 text-center">
            <p className="text-sm text-stone-500 dark:text-stone-400">今日は、どう話そう？</p>
            <div className="flex flex-wrap justify-center gap-3">
              {PERSONAS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => handleSwitchPersona(p.value)}
                  className="rounded-2xl border border-stone-300/70 px-7 py-5 text-center text-base text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-100 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div ref={scrollAnchorRef} />

        {/*
          スマホでは、会話本文が下部の入力UIに近づいたときに、境界で唐突に切れるのではなく
          下方向へ徐々に背景へ溶け、その先は完全に不透明な背景色で覆われるようにするための
          装飾オーバーレイ。「グラデーションで薄くする層」と「完全不透明で覆う層」を分離した
          2層構造にしている（詳細は各層のコメント参照）。
          （検証の結果、position: absoluteだけではmain内のスクロールと一緒に動いてしまい
          「常にmainの可視下端に留まる」効果にならないことが判明したため、sticky＋
          absoluteの組み合わせにしている。）
          外側：sticky bottom-0のゼロ高さ（h-0）要素。stickyなのでスクロールしても常に
          mainのcontent box下端（＝padding-bottomの内側、main pb-12の始まる位置）に
          留まる基準点になる。h-0のため、それ自体はscrollHeightに高さを追加しない。
          ただしflex-colの子である以上、直前の要素（scrollAnchorRef）との間にgap-6
          （24px）が自動的に入ってしまうため、-mt-6でちょうど打ち消し、scrollHeight・
          maxScrollTopへの影響を実質ゼロにする。
          （外側のbottomをbottom-0以外の値にする、つまりcontent box下端より外側で
          stickyさせようとすると、最大スクロール時にscrollAnchorRefの自然なフロー位置
          そのものがcontent box下端に来てしまい、その位置がstickyの固定先より内側に
          あるためstickyが機能せず自然位置へ戻ってしまう＝スクロール位置によって位置が
          変わってしまう不具合を実機確認で踏んだため、外側は常にcontent box下端に
          固定する素直なbottom-0のままにしている。この基準点＝main pb-12の始点から、
          pb-12の値そのもの（48px）だけ下へ行けば、必ずmainのborder-box下端＝bottomUI
          との実際の境界に一致する。この48pxという関係はスクロール量にも会話内容にも
          左右されない固定値なので、以下の2層はこれを使って正確に位置決めしている。）
          内側1（完全不透明の背景色レイヤー、bottomUIとの境界に一番近い側）：
          absolute inset-x-0 -bottom-12 h-6。基準点から48px下＝border-box下端
          （bottomUIとの境界）にぴったり届くように配置し、そこから24px分（h-6）を
          グラデーションなしの完全不透明なbg-[var(--background)]で塗りつぶす。
          「フェードの先が透明のまま残らないように」という要件に対し、以前は
          グラデーションのfrom側が実質的に不透明になる性質に頼っていたが、今回は
          明示的に不透明な単色レイヤーとして分離し、会話テキストが入力UI付近で
          透けて見える余地を構造的になくす。
          内側2（グラデーションレイヤー、本文を徐々に薄くする側）：
          absolute inset-x-0 -bottom-6 h-[72px]。内側1のすぐ上（内側1の上端＝
          基準点から24px下の位置）に、下端をぴったり接続させる形で配置し、
          そこから72px分を`from-[var(--background)] to-transparent`のグラデーション
          にする。最下部までスクロールした状態で、最後の吹き出しの下部約24pxが
          このグラデーションと重なり、「文章→薄くなる→内側1の完全な背景色」へ
          自然につながるように高さ・位置を実測のうえ決定している（数値の最小化が
          目的ではなく、「本文が背景へ溶けて、その先は完全に覆われる」という見た目を
          優先した結果の値）。
          両レイヤーとも、documentフローの外にあるabsolute配置のため、sticky特有の
          「自然位置の上限」制約を受けず、常に安定した基準点を保てる（実測でスクロール
          位置に関わらず一定であることを確認済み）。
          両レイヤーとも境界がmainのborder-box下端（＝bottomUIとの実際の境界）を
          超えないよう正確に計算しているため、bottomUI自体の領域には一切重ならず、
          pointer-events-noneも付与しているため、万一のsubpixelなズレがあっても
          入力欄・送信ボタン・↺・＋・⚙のクリック/タップ/フォーカスを妨げない。
          色は`var(--background)`を使うため、ライト/ダーク双方の背景色へ自動的に溶け込む
          （他パネル：SettingsPanel等と同じ変数を使用）。
          PCでは見た目を変えないため`sm:hidden`でスマホのみに限定する。
          会話本文・scrollAnchorRef・streamingText・main pb-12/gap-6・bottomUI・
          textarea・40×40pxボタン・keyboardVisibleロジックには一切変更なし。
        */}
        <div className="sticky bottom-0 -mt-6 h-0 sm:hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -bottom-12 h-6 bg-[var(--background)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -bottom-6 h-[72px] bg-gradient-to-t from-[var(--background)] to-transparent"
          />
        </div>
      </main>

      {/*
        「入力欄（footer）」と「AI/保存先・↺＋⚙（bottom navigation）」を、視覚的にも
        構造的にも1つの下部UI（bottomUI）としてまとめる。
        以前はfooter自身のpb・bottom navigation自身のpt/pbという3つの独立した余白が
        「status→アイコン」「アイコン→画面下端」の間隔を分担していたため、片方だけ
        調整するともう片方との継ぎ目がズレて見える問題があった（詳細は前回の構造分析）。
        今回はそれらを、このラッパー1つが持つ`gap-*`（footer塊とbottom navigation塊の
        間隔）と`pb-*`（bottom navigationの下＝画面/キーボードとの間隔）の2つだけに
        集約し、値の出どころを一本化する。footer・bottom navigation自身はもう独自の
        pt/pbを持たない（下記それぞれの開始タグを参照）。
        keyboardVisible時はラッパーのpbだけを圧縮する（アイコン下の余白を詰める）。
        gap（status→アイコンの間隔）はkeyboardVisibleに関わらず常に一定にし、
        「上を詰めすぎない」という実機フィードバックを反映する。
        PCはsm:gap-7・sm:pb-4で、これまでの実測値（footer pb-6=24px + bottomNav pt-1=4px
        → 計28px＝gap-7と一致／bottomNav pb-4=16px→そのままpb-4）と完全に一致させており、
        PC側の見た目は一切変化しない。
        アイコンのタップ領域自体（各40×40px）・-my-3・入力欄の1〜4行仕様・
        visualViewportによるkeyboard detectionロジックは変更しない。
      */}
      <div
        className={`flex flex-col gap-2 sm:gap-7 ${keyboardVisible ? "pb-0" : "pb-2"} sm:pb-4`}
      >
      {!showEntryScreen && (
      <footer className="mx-auto w-full max-w-2xl px-5">
        <div className="flex items-end gap-2 rounded-2xl border border-stone-300/70 bg-white/70 p-2 shadow-sm dark:border-stone-700/70 dark:bg-stone-900/60">
          {/*
            入力欄（textarea・自動リサイズ・↺/＋/送るボタン）はChatInputへ切り出して
            いる。理由・詳細はChatInpu本体のコメントを参照（iPad ChromeでBackspace
            長押しが連続削除にならない問題の調査を踏まえ、1文字ごとのsetStateで
            ChatScreen全体が再レンダリングされないようにするため）。
            key={inputResetKey}：ペルソナ切替・トップへ戻る際に「入力中の下書きを
            クリアする」という既存仕様を、ChatInputのローカルstateへ外部から
            触れずに実現するため、keyを変えてChatInputごと再マウントさせている。
          */}
          <ChatInput
            key={inputResetKey}
            disabled={busy}
            placeholder={
              PERSONAS.find((p) => p.value === persona)?.placeholder ?? "話しかけてみてください"
            }
            onSend={(text) => void handleSend(text)}
            onOpenHistory={() => setHistoryOpen(true)}
            onOpenImport={() => setImportOpen(true)}
          />
        </div>

        {/*
          入力欄→ステータス文言の間隔（mt-1）は、キーボード表示時も含めて常に一定にする。
          以前はkeyboardVisible時にmt-0まで詰めていたが、実機確認の結果「入力欄と
          ステータスが近すぎる」という不自然さが出たため、ここは圧縮対象から外す
          （余白を削るのは下記bottom navigationの下端側に限定する）。
        */}
        {/*
          「記憶に残しています…」「記憶に残しました。」は、以前dd7c62eで一度廃止し
          （『ここまでを記憶しました。』を「この会話を終える」時だけの別カードに一本化した
          ため）、その後常時無表示になっていた。今回、会話が裏で自動保存され続けている
          ことがユーザーから一切見えず、「本当に保存されているのか」が終了操作まで
          分からないという指摘を受け、Memory保存の進行状態を伝える控えめな文言として復活
          させる。表示先はcaptureStatusのみで、新しいstate・新しい判定は追加していない
          （captureStatus自体・Capture/保存処理・保存タイミングは一切変更していない。
          表示するかどうかを戻しただけ）。
          役割の違い：この行は「今、裏で保存処理が動いているか」を示す一時的なステータス
          （会話中、ターンのたびに一瞬だけ出ては消える）。一方「ここまでを記憶しました。」
          カードは「この会話を終える」を押した時だけ出る、今回のConversation全体の
          Memoryの一覧（summary込み）。前者は経過、後者は結果のまとめであり、役割は
          重複しない。
        */}
        <p
          className={`mt-1 h-4 text-xs transition-opacity sm:mt-2 ${
            captureStatus === "error" || captureStatus === "partial"
              ? "text-red-600 dark:text-red-400"
              : "text-stone-400 dark:text-stone-500"
          }`}
        >
          {captureStatus === "saving" && "記憶しています…"}
          {captureStatus === "saved" && "記憶しました。"}
          {captureStatus === "partial" && "一部の記憶を保存できませんでした。会話は続けられます。"}
          {captureStatus === "error" && "記憶の保存に失敗しました。"}
        </p>
        {sendStatus === "authError" && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
            APIキーが無効または期限切れの可能性があります。設定を確認してください。
          </p>
        )}
        {sendStatus === "error" && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
            メッセージの送信に失敗しました。しばらくしてからもう一度お試しください。
          </p>
        )}
      </footer>
      )}

      {/*
        PC（sm以上）は現状どおり1行（現在使用するAI・保存先・設定を開く⚙）。
        スマホ（sm未満）はAI名・保存先の常時表示テキストを外し、アイコンのみの行にする
        （情報自体は⚙から開くSettingsPanelで確認できるため、会話画面下部の占有を減らす）。
        履歴・Importは入力欄から出した分をここへ移し、スマホでもタップ1つでアクセス
        できるようにする（handlerは footer 側と同じもの＝setHistoryOpen/setImportOpenを
        再利用するだけで、新しい処理・stateは追加しない）。
        pt/pbはもう持たない（footerとの間隔・画面下端との間隔は、この行を包む
        bottomUIラッパー側のgap/pbに一本化した。上のコメント参照）。
      */}
      <div className="mx-auto flex w-full max-w-2xl items-center justify-center gap-1.5 px-5 text-xs text-stone-400 dark:text-stone-500">
        <span className="hidden sm:inline">{PROVIDER_LABEL[chatProvider]}</span>
        <span aria-hidden="true" className="hidden sm:inline">・</span>
        <span className="hidden sm:inline">{vaultStatusLabel}</span>
        <span aria-hidden="true" className="hidden sm:inline">・</span>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          aria-label="これまでの記憶を見る"
          className="-my-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300 sm:hidden"
        >
          ↺
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          aria-label="読み込む"
          className="-my-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300 sm:hidden"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="設定"
          className="-my-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300"
        >
          ⚙
        </button>
      </div>
      </div>

      {settingsOpen && (
        <div className="fixed inset-0 z-40">
          <SettingsPanel
            chatProvider={chatProvider}
            keyStatusByProvider={keyStatusByProvider}
            vaultStatus={vaultStatus}
            vaultHandle={vaultHandle}
            vaultBackend={vaultBackend}
            vaultConnectFeedback={vaultConnectFeedback}
            restoreCandidate={restoreCandidate}
            restoreStatus={restoreStatus}
            onClose={() => setSettingsOpen(false)}
            onDeleteApiKey={(deleteTarget) => void handleDeleteApiKey(deleteTarget)}
            onOpenApiKeySetup={(provider) => setApiKeySetupProvider(provider)}
            onSelectChatProvider={handleSelectChatProvider}
            onConnectVault={() => void handleConnectVault()}
            onReauthorizeVault={() => void handleReauthorizeVault()}
            onRestoreFromVault={() => void handleRestoreFromVault()}
            exportDataFeedback={exportDataFeedback}
            deleteDataFeedback={deleteDataFeedback}
            onExportData={() => void handleExportData()}
            onDeleteData={() => void handleDeleteData()}
          />
        </div>
      )}

      {importOpen && (
        <div className="fixed inset-0 z-40">
          <ImportPanel vaultHandle={vaultHandle} onClose={() => setImportOpen(false)} />
        </div>
      )}

      {historyOpen && (
        <div className="fixed inset-0 z-40">
          <HistoryPanel
            initialMemoryId={historyInitialMemoryId}
            onClose={() => {
              setHistoryOpen(false);
              setHistoryInitialMemoryId(undefined);
            }}
          />
        </div>
      )}

      {apiKeySetupProvider && (
        <div className="fixed inset-0 z-50">
          <ApiKeySetup
            provider={apiKeySetupProvider}
            onClose={() => setApiKeySetupProvider(null)}
            onSaved={(savedProvider) => {
              setApiKeySetupProvider(null);
              refreshKeyStatus();
              if (savedProvider === "openai") handleSelectChatProvider("openai");
            }}
          />
        </div>
      )}
      <DebugTimingPanel />
    </div>
  );
}

/**
 * メインチャットの入力欄（textarea + 履歴/Import/送るボタン）を、ChatScreen本体から
 * 切り出した子コンポーネント。
 *
 * 経緯：iPad Chrome（実質WebKit）実機で「Backspaceを押しっぱなしにしても連続削除に
 * ならない」という不具合が報告された。調査の結果、以前は`input`（入力中のテキスト）が
 * ChatScreen本体のuseStateだったため、1文字ごとの`setInput()`のたびにChatScreen
 * コンポーネント全体（会話ターン一覧のmapを含む巨大なJSXツリー全体の差分計算・
 * 他の多数のuseEffect等）が再レンダリングされる構造になっていた。PC Chrome・
 * Android Chromeでは体感できるほどの遅延にならないが、iPad上のWebKit
 * （JavaScriptCore）はこの種の頻繁な再レンダリングに弱く、OSのキーリピート間隔に
 * 再レンダリングが追いつかないと、ネイティブ側のBackspace長押し連続削除そのものが
 * 途中で止まってしまう（＝2文字目以降のinputイベントに対する反映が間に合わず、
 * ブラウザ側が「反応がない」と判断してリピートを継続しない）と考えられる。
 *
 * 対策として、入力中のテキスト自体をこのChatInputコンポーネントの中だけで完結する
 * ローカルstateにした。1文字ごとのsetStateはChatInput自身だけを再レンダリングし、
 * ChatScreen本体（会話ターン一覧等）は一切再レンダリングされなくなる。
 *
 * ChatScreen側が知る必要があるのは「送信された最終的なテキスト」だけなので、
 * 送信は`onSend(text: string)`というコールバックで親へ通知する（親のhandleSend()は
 * 既存のoverrideText引数をそのまま使えるため、ロジック自体は変更していない）。
 * 送信後はこのコンポーネント自身がローカルstateを空文字へ戻す。
 *
 * 「ペルソナ切替・トップへ戻る際に入力中の下書きをクリアする」という既存仕様は、
 * 親（ChatScreen）がこのコンポーネントに渡す`key`を変えることで実現する
 * （keyが変わるとReactはこのコンポーネントを丸ごと再マウントし、ローカルstateは
 * 初期値の空文字に戻る。ChatScreen側からローカルstateへ直接触る手段は持たせない）。
 *
 * 履歴（↺）・Import（＋）ボタンも、DOM上の見た目の並び順（textarea→↺→＋→送る）を
 * 崩さずに済むよう、そのままこのコンポーネント内に含めている。ただし
 * historyOpen/importOpenのstate自体は従来どおりChatScreen側が持っており、
 * このコンポーネントはonOpenHistory/onOpenImportコールバックを呼ぶだけ
 * （表示の委譲のみで、状態のオーナーシップは変更していない）。
 *
 * textareaのauto-resize処理（iPad向け強制リフロー削減の最適化を含む）は、
 * 元のChatScreen側のuseEffectから処理内容を変更せずそのまま移設している。
 * min-h-10/max-h-24/sm:min-h-24/sm:max-h-64/text-base sm:text-sm等の見た目の仕様、
 * rows={1}、Enterで送信しない（IME変換確定のEnterで誤送信しない）という既存仕様も
 * 一切変更していない。
 */
function ChatInput({
  disabled,
  placeholder,
  onSend,
  onOpenHistory,
  onOpenImport,
}: {
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onOpenHistory: () => void;
  onOpenImport: () => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const currentHeightPx = el.style.height ? parseFloat(el.style.height) : el.clientHeight;
    if (el.scrollHeight > currentHeightPx) {
      const next = `${el.scrollHeight}px`;
      if (el.style.height !== next) el.style.height = next;
      return;
    }
    el.style.height = "auto";
    const next = `${el.scrollHeight}px`;
    if (el.style.height !== next) el.style.height = next;
  }, [value]);

  function handleSendClick() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  }

  return (
    <>
      {/*
        Enterは常に改行（送信しない）。「送る」ボタンのみが送信手段（過去からの
        問いかけ用textareaと統一）。日本語IME変換確定のEnterで誤送信される問題を
        避けるため、Enterへの特別な処理自体を持たせない。
      */}
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="min-h-10 max-h-24 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-base outline-none placeholder:text-stone-400 disabled:opacity-60 sm:min-h-24 sm:max-h-64 sm:text-sm"
      />
      <button
        type="button"
        onClick={onOpenHistory}
        aria-label="これまでの記憶を見る"
        className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300 sm:flex"
      >
        ↺
      </button>
      <button
        type="button"
        onClick={onOpenImport}
        aria-label="読み込む"
        className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300 sm:flex"
      >
        ＋
      </button>
      <button
        onClick={handleSendClick}
        disabled={disabled || !value.trim()}
        className="shrink-0 rounded-xl bg-stone-800 px-4 py-2 text-sm text-stone-50 transition disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
      >
        送る
      </button>
    </>
  );
}

function TurnBubble({ turn }: { turn: ConversationTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-stone-800 px-4 py-2 text-sm text-stone-50 dark:bg-stone-200 dark:text-stone-900">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
      {turn.content}
    </div>
  );
}
