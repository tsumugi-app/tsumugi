"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation, ConversationTurn, MemoryObject, Persona } from "@/lib/types";
import { appendTurn, captureConversation, createConversation, persistCapture } from "@/lib/capture";
import {
  chooseVaultDirectory,
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
import HistoryPanel from "./HistoryPanel";

/** ApiKeySetupと同じく、chatで選べるproviderは今回この2つに限定する（Claudeは型のみ）。 */
export type SupportedChatProvider = "gemini" | "openai";

export type VaultStatus = "checking" | "connected" | "not-connected" | "unsupported" | "needs-permission";
/** Beta C3対応：フォルダ選択のキャンセル／接続失敗を、vaultStatusを汚さずに一時的なメッセージとして出す。 */
export type VaultConnectFeedback = { kind: "cancelled" | "error"; message: string };
type CaptureStatus = "idle" | "saving" | "saved" | "partial" | "error";
type ReflectionStatus = "idle" | "generating" | "done" | "error" | "unavailable";
export type RestoreStatus = "idle" | "restoring" | "done";
type SendStatus = "idle" | "error" | "authError";

export interface RestoreCandidate {
  scan: VaultScanResult;
  newCount: number;
}

/** 1回のアプリ起動あたり、未Connect Memoryをまとめて処理する上限（AI呼び出し回数のクォータ保護）。 */
const STARTUP_CONNECT_LIMIT = 3;

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
  /** そのConversationから既に生成済みの、新規/更新されたMemoryObjectの一覧（1 Conversation = 1 Memoryとは限らない）。 */
  const [memoryObjects, setMemoryObjects] = useState<MemoryObject[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const { message: waitingMessage, start: startWaiting, stop: stopWaiting } = useWaitingMessage();
  const [vaultHandle, setVaultHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("checking");
  const [vaultConnectFeedback, setVaultConnectFeedback] = useState<VaultConnectFeedback | null>(null);
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
   * スマホでソフトウェアキーボードが表示中かどうか。footer・下部アイコン行の
   * 余白圧縮だけに使う表示専用state（Vault/Memory等の既存ロジックには一切関係しない）。
   * PC幅ではCSS側（各所の`sm:`）が常にこのstateの値を上書きするため、たとえこのstateが
   * 誤ってtrueになってもPCの見た目には影響しない。
   */
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const topPromptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const startupConnectRanRef = useRef(false);
  const topPromptRanRef = useRef(false);
  /**
   * Captureをチャット送信のブロッキングから切り離すためのPromiseキュー（1件ずつ直列実行）。
   * 次のCaptureには、前のCaptureが返したmemoryObjects一覧を明示的に渡す
   * （React stateのクロージャに依存すると、Capture同士が競合してMemoryObjectを二重生成しうるため）。
   */
  const captureQueueRef = useRef<Promise<MemoryObject[]>>(Promise.resolve(memoryObjects));
  /** setConversationを呼ぶ箇所では必ず同時に更新する、常に最新のconversationを指すref。 */
  const latestConversationRef = useRef(conversation);

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

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation.turns.length, streamingText]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

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
   * Captureをキューへ積む。awaitせずバックグラウンドで実行され、チャット送信をブロックしない。
   * snapshotはenqueue時点のconversationに固定する（ターンNのCaptureが、後から追加された
   * ターンN+1を勝手に取り込まないようにするため）。
   */
  function enqueueCapture(snapshot: Conversation) {
    captureQueueRef.current = captureQueueRef.current.then(async (prevMemoryObjects) => {
      try {
        setCaptureStatus("saving");
        const { conversation: capturedDelta, memoryObjects: touchedMemoryObjects } = await captureConversation(
          snapshot,
          prevMemoryObjects
        );
        const { conversationFailed, failedMemoryIds } = await persistCapture(
          vaultHandle,
          capturedDelta,
          touchedMemoryObjects
        );
        // 保存に成功したMemoryだけを以降の処理（revisitPrompt生成・state反映）へ進める。
        // IndexedDB書き込み自体が失敗したMemoryは、成功した他のMemoryを巻き込まないよう
        // ここで除外する（Beta修正：以前はここで1件でも失敗すると全件が失われていた）。
        const persistedMemoryObjects = touchedMemoryObjects.filter(
          (memory) => !failedMemoryIds.includes(memory.id)
        );

        // Beta「過去からの問いかけ」。revisitPromptをまだ持たないMemory（＝今回新しく
        // 生成された、または初めてCaptureされたMemory）だけを対象に、そのMemory単体を
        // 材料として再訪用の問いかけを1回だけ生成し、保存し直す。既にrevisitPromptを
        // 持つMemoryは再生成しない。ここで失敗しても既存のCapture結果自体は失わない
        // （revisitPromptが付かないだけで、次にこのMemoryが更新された際に再度試みられる）。
        const memoriesWithRevisitPrompt = await Promise.all(
          persistedMemoryObjects.map(async (memory) => {
            if (memory.revisitPrompt) return memory;
            try {
              const revisitPrompt = await generateRevisitPrompt(memory);
              if (!revisitPrompt) return memory;
              const memoryWithPrompt: MemoryObject = { ...memory, revisitPrompt };
              await putMemoryObject(memoryWithPrompt);
              return memoryWithPrompt;
            } catch (error) {
              console.error("Failed to generate revisit prompt", error);
              return memory;
            }
          })
        );

        const touchedIds = new Set(memoriesWithRevisitPrompt.map((memory) => memory.id));
        const mergedMemoryObjects = [
          ...prevMemoryObjects.filter((memory) => !touchedIds.has(memory.id)),
          ...memoriesWithRevisitPrompt,
        ];

        // このCaptureが対象にしていたConversationが、実行中に「本日はここまで」→新規会話開始等で
        // 既に切り替わっていた場合は、古い結果を今のstateへ書き戻さない（別会話の汚染防止）。
        // setStateのfunctional updaterはこの時点で同期的に実行される保証が無いため、
        // 常に同期的に最新値を持つlatestConversationRefで判定する。
        if (latestConversationRef.current.id !== capturedDelta.id) {
          return prevMemoryObjects;
        }

        const merged: Conversation = {
          ...latestConversationRef.current,
          status: capturedDelta.status,
          // 保存に失敗したMemoryのidは、conversation.memoryObjectIdsからも除く
          // （実際にIndexedDBへ保存できたものだけを指すようにする）。
          memoryObjectIds: capturedDelta.memoryObjectIds.filter((id) => !failedMemoryIds.includes(id)),
          updatedAt: capturedDelta.updatedAt,
        };
        latestConversationRef.current = merged;
        setConversation(merged);
        setMemoryObjects(mergedMemoryObjects);

        // Beta修正：一部のMemoryだけ保存に失敗した場合も、成功した分は反映した上で、
        // 失敗があったことをユーザーへ明示する（黙って"saved"にしない）。
        if (conversationFailed || failedMemoryIds.length > 0) {
          console.error("Partial capture failure", { conversationFailed, failedMemoryIds });
          setCaptureStatus("partial");
        } else {
          setCaptureStatus("saved");
          window.setTimeout(() => setCaptureStatus("idle"), 2500);
        }
        return mergedMemoryObjects;
      } catch (error) {
        console.error("Failed to capture memory", error);
        setCaptureStatus("error");
        // 失敗しても次のCaptureへ、直前まで有効だったmemoryObjects一覧をそのまま引き継ぐ。
        return prevMemoryObjects;
      }
    });
  }

  /**
   * 「本日はここまで」。UI_UX.md「Users never press Save」の"Save"ではない
   * （保存は既にCaptureが自動で行っている）。あくまで任意の締めくくりの操作。
   * 既存のCaptureは呼ばない。既存のmemoryObjectを材料に、別のinsight MemoryObjectを1つ作る。
   */
  async function handleEndSession() {
    // バックグラウンドで実行中のCaptureが残っていれば、ここで完了を待つ
    // （memoryObjectsが最新状態になってから振り返りの材料として使うため）。
    const latestMemoryObjects = await captureQueueRef.current;

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

      // Connect（ROADMAP.md Phase 2）。Reflection表示をブロックしないよう非同期で走らせる。
      // 失敗してもReflection自体は成功しているため、reflectionStatusには影響させない
      // （未Connectのまま残り、次回起動時のキャッチアップで再試行される）。
      void (async () => {
        try {
          for (const memory of latestMemoryObjects) {
            await connectMemory(vaultHandle, memory);
          }
          await connectMemory(vaultHandle, insightMemory);
        } catch (connectError) {
          console.error("Failed to connect session memories", connectError);
        }
      })();
    } catch (error) {
      console.error("Failed to generate session reflection", error);
      setReflectionStatus("error");
    }
  }

  /**
   * 会話境界（ペルソナ切り替え・トップへ戻る・終了済みConversationからの新規開始）で、
   * 離れる直前のConversationのMemoryをConnect対象にする。handleEndSession()が
   * セッション終了時に行っているのと同じパターン（画面遷移をブロックしないfire-and-forget）
   * をそのまま再利用するだけで、新しいConnect機構・新しいタイマーは作らない。
   *
   * pendingMemoryObjectsには、呼び出し時点（=captureQueueRef.currentを次の値へ
   * 上書きする直前）のcaptureQueueRef.currentをそのまま渡す。これは進行中のCaptureが
   * 完了した後の最終的なMemoryObject一覧を指すPromiseであり、state変数のmemoryObjects
   * （再レンダーを挟まないと最新にならない）ではなくこちらを使うことで、画面遷移で参照が
   * 失われる前に対象を確実に確保できる。
   *
   * 会話中のMemory（まだCaptureで更新され続けている途中のもの）はConnect対象にしない
   * ——という設計方針は、この関数が「離れる」操作からしか呼ばれないことで担保される
   * （enqueueCapture成功直後などからは呼ばない）。
   *
   * 同じMemoryが「本日はここまで」・起動時キャッチアップ・この会話境界Connectの
   * 複数経路から対象になっても、connectMemory()内のtryClaimMemoryForConnect()による
   * 既存のクレーム機構がそのまま重複実行を防ぐ。
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
   * 会話中の「日記／探究／相談・創造」。Personaを途中で切り替えるのではなく、
   * 新しいConversationを始めるボタンとして扱う（トップ画面の入口と同じPersonaを使う）。
   * 画面上は完全に新しい会話として始まり、古いConversationの内容は表示しない。
   * ただし古いConversationはこれまでのCaptureで既に随時保存済みであり、ここでは
   * IndexedDB/Vaultへの削除も上書きも行わない（React state上の参照を新しい
   * Conversationへ切り替えるだけ）。handleSend()の「終了済みConversationへは
   * 追記せず新規作成する」分岐と全く同じリセット処理を再利用する。
   */
  function handleSwitchPersona(nextPersona: Persona) {
    connectConversationBoundary(captureQueueRef.current);

    const newConversation = createConversation(nextPersona);
    setConversation(newConversation);
    latestConversationRef.current = newConversation;
    setPersona(nextPersona);
    setMemoryObjects([]);
    captureQueueRef.current = Promise.resolve([]);
    setReflectionStatus("idle");
    setReflectionText("");
    setInput("");
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
    connectConversationBoundary(captureQueueRef.current);

    const newConversation = createConversation(persona);
    setConversation(newConversation);
    latestConversationRef.current = newConversation;
    setMemoryObjects([]);
    captureQueueRef.current = Promise.resolve([]);
    setReflectionStatus("idle");
    setReflectionText("");
    setInput("");
    setStreamingText("");
    setSendStatus("idle");
    setEntryConfirmed(false);
  }

  /**
   * overrideTextが渡された場合はinput stateではなくそちらを送信する（過去からの問いかけ用）。
   * overridePersonaも同様。personaは closure変数のため、呼び出し元がsetPersona()した直後に
   * 再レンダーを挟まず本関数を呼ぶケース（過去からの問いかけ）では、closure変数のpersonaは
   * まだ更新前の値のままになる（baseConversationをlatestConversationRefから読む理由と同じ）。
   */
  async function handleSend(overrideText?: string, overridePersona?: Persona) {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    const activePersona = overridePersona ?? persona;

    setInput("");
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
      connectConversationBoundary(captureQueueRef.current);

      baseConversation = createConversation(activePersona);
      setConversation(baseConversation);
      latestConversationRef.current = baseConversation;
      setMemoryObjects([]);
      captureQueueRef.current = Promise.resolve([]);
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

      // Captureの完了を待たず、ここで次の入力を可能にする。Captureはバックグラウンドで継続する。
      setBusy(false);
      enqueueCapture(updated);
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
      <div className="flex items-center justify-center px-4 pt-8 pb-3">
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
      */}
      {vaultStatus === "needs-permission" && vaultHandle && !vaultReauthDismissed && (
        <div className="mx-auto w-full max-w-2xl px-5">
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
        </div>
      )}

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
            <div className="flex flex-wrap justify-center gap-3">
              {PERSONAS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => {
                    setPersona(p.value);
                    setEntryConfirmed(true);
                  }}
                  className="rounded-2xl border border-stone-300/70 px-7 py-5 text-center text-base text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-100 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                >
                  {p.label}
                </button>
              ))}
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

        {persona === "companion" &&
          conversation.turns[conversation.turns.length - 1]?.role === "ai" &&
          !conversation.endedAt && (
          <div className="flex flex-col items-center gap-2 pt-4 text-center">
            <button
              onClick={() => void handleEndSession()}
              disabled={reflectionStatus === "generating"}
              className="text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600 disabled:opacity-50 dark:text-stone-500 dark:decoration-stone-700 dark:hover:text-stone-300"
            >
              本日はここまで
            </button>
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

        {reflectionStatus === "done" && (
          <div className="rounded-2xl border border-stone-300/60 bg-stone-100/60 px-5 py-4 dark:border-stone-700/60 dark:bg-stone-900/40">
            <p className="mb-2 text-xs text-stone-400 dark:text-stone-500">今日の振り返り</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
              {reflectionText}
            </p>
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
            Enterは常に改行（送信しない）。「送る」ボタンのみが送信手段（過去からの
            問いかけ用textareaと統一）。日本語IME変換確定のEnterで誤送信される問題を
            避けるため、Enterへの特別な処理自体を持たせない。
          */}
          {/*
            スマホ（sm未満）では最初から大きな入力欄にしない：min-heightを1行程度
            （min-h-10）に下げ、入力量に応じて上へ伸びるようにする（items-endの行内で
            テキストエリアの高さだけが増える＝下端は送るボタンと揃ったまま、上端だけが
            上に伸びる）。ソフトウェアキーボード表示中に本文が読めなくなるのを避けるため、
            スマホのmax-heightは4行相当（max-h-24＝96px。実測：1行40px→2行56px→3行76px→
            4行96px、以降1行20pxずつ増加）に抑え、それ以上は画面下方向へ広がらせず
            textarea内部を縦スクロールさせる（overflow-y-autoは既存のまま）。
            PC（sm以上）はmin-h-24・max-h-64のまま、既存の見た目を変えない。
            自動リサイズ自体は下のuseEffect（[input]に依存、325行目付近）が既に
            El.scrollHeightで行っており、新しいstate・新しいロジックは追加していない。
          */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              PERSONAS.find((p) => p.value === persona)?.placeholder ?? "話しかけてみてください"
            }
            disabled={busy}
            className="min-h-10 max-h-24 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm outline-none placeholder:text-stone-400 disabled:opacity-60 sm:min-h-24 sm:max-h-64"
          />
          {/*
            スマホ（sm未満）では入力欄から履歴・Importボタンを外し、textareaの横幅を
            最大限確保する（送るボタンのみ残す）。PC（sm以上）では既存どおり表示する。
            機能・handlerは変更せず、表示のみをブレークポイントで切り替える
            （同じ操作はスマホでは下部のアイコン行から行える。7-2参照）。
          */}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-label="これまでの記憶を見る"
            className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300 sm:flex"
          >
            ↺
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            aria-label="読み込む"
            className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg leading-none text-stone-400 transition hover:bg-stone-900/5 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-white/5 dark:hover:text-stone-300 sm:flex"
          >
            ＋
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-xl bg-stone-800 px-4 py-2 text-sm text-stone-50 transition disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
          >
            送る
          </button>
        </div>

        {/*
          入力欄→ステータス文言の間隔（mt-1）は、キーボード表示時も含めて常に一定にする。
          以前はkeyboardVisible時にmt-0まで詰めていたが、実機確認の結果「入力欄と
          ステータスが近すぎる」という不自然さが出たため、ここは圧縮対象から外す
          （余白を削るのは下記bottom navigationの下端側に限定する）。
        */}
        <p
          className={`mt-1 h-4 text-xs transition-opacity sm:mt-2 ${
            captureStatus === "error" || captureStatus === "partial"
              ? "text-red-600 dark:text-red-400"
              : "text-stone-400 dark:text-stone-500"
          }`}
        >
          {captureStatus === "saving" && "記憶に残しています…"}
          {captureStatus === "saved" &&
            (vaultStatus === "connected" ? "記憶に残しました。" : "この端末にのみ保存しました。")}
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
          <HistoryPanel onClose={() => setHistoryOpen(false)} />
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
    </div>
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
