"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  isHistoryDayIndexV2,
  readConversationById,
  readHistoryMonthIndex,
  readMemoriesForDay,
  readReflectionById,
  truncateHistoryPreview,
  upgradeHistoryDayToV2,
} from "@/lib/vault";
import type { HistoryDayIndexV2, HistoryMonthIndex } from "@/lib/vault";
import type { Conversation, ConversationTurn, MemoryObject, MemoryType, Persona } from "@/lib/types";

/** MemoryType（英語の列挙値）をUI表示用の日本語ラベルへ変換する。既存のtypes.tsの語彙のみを使う。 */
const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  conversation: "会話",
  diary: "日記",
  idea: "アイデア",
  emotion: "感情",
  goal: "目標",
  person: "人物",
  event: "出来事",
  insight: "気づき",
};

/**
 * History上のConversation表示名は「日記」「会話」の2つだけに正規化する
 * （persona==="companion"のみ「日記」、coach/analystを含むそれ以外は一律「会話」）。
 * 現在のチャットUI自体が「日記」「会話」の2択（ChatScreen.tsx参照）であり、旧
 * 「探究」「相談・創造」という名称はHistory上には一切表示しない。Conversation本体の
 * `persona`フィールド自体は変更しない（表示レイヤーでの正規化のみ）。
 * `src/lib/vault.ts`のHistory Index v2書き込み時の正規化ルールと同一。
 */
function personaModeLabel(persona: Persona): string {
  return persona === "companion" ? "日記" : "会話";
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Vault内のMarkdown命名規則（`fileNameFor`/`dayFileNameFor`、`src/lib/vault.ts`）は
 * すべて`ISODateString.slice(0, 10)`（UTC基準の日付文字列）を単位にしている。
 * カレンダー上の「今日」・「今日だけIndexedDBとマージする」判定も、この同じ基準に
 * 揃える（ローカル時刻の「今日」とVault側の日付バケットがずれないようにするため）。
 */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthKeyOf(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

function dayKeyOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * 日曜始まりの月カレンダーを、週ごと（7列、無い日はnull）の配列として生成する。
 * 外部カレンダーAPI・ライブラリは使わず、`Date`の計算だけで求める（祝日表示は無し）。
 * カレンダーのグリッド自体はユーザーのローカル時刻の「その月」を表示する
 * （Vault側の日付バケット＝UTC基準の日付文字列とは独立した、純粋な表示上の月送り）。
 */
function buildMonthGrid(year: number, month: number): (string | null)[][] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = new Date(year, month - 1, 1).getDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(dayKeyOf(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/**
 * Conversation一覧行（History Index v2）。v2の日はHistory Indexの
 * `HistoryConversationSummary`から直接作る（`full`は未設定＝本体未読）。v1
 * fallbackの日はConversation本体を読み終えているため`full`を設定し、詳細表示時に
 * 追加のreadを発生させない。
 */
interface ConversationRow {
  id: string;
  modeLabel: string;
  turnCount: number;
  full?: Conversation;
}

/**
 * 通常Memory／Reflection共通の一覧行。`origin`で詳細表示時にどちらの本体read経路
 * （`readMemoriesForDay`+find／`readReflectionById`）を使うかを判定する
 * （`types`だけでは判別できない——通常Memoryも`types`に"insight"を持ちうるため）。
 */
interface MemoryRow {
  id: string;
  types: MemoryType[];
  preview: string;
  createdAt: string;
  origin: "normal" | "reflection";
  full?: MemoryObject;
}

/** 同一History表示セッション内だけの短期キャッシュ1件分。 */
interface DayCacheEntry {
  conversationRows: ConversationRow[];
  memoryRows: MemoryRow[];
}

/**
 * 「いつ何を話したかを見る場所」という時間軸中心のHistory UI（Vault読込方式の
 * 再設計、History Index v2）。
 *
 * v2の日：`.tsumugi/history/YYYY-MM.json`（月Index）に、一覧表示に必要な軽量データ
 * （Conversationのmode/turnCount、通常Memory/Reflectionのtypes/preview）を直接持つ
 * ため、日付タップ時にVault本体（Conversation/Reflection/通常MemoryのMarkdown）を
 * 一切読まずに一覧を描画できる。
 *
 * v1の日（History Index v2導入より前の既存Vaultで、まだ一度も開かれていない日）：
 * 従来通りid経由でMarkdown本体を読むfallbackで一覧を組み立てる。Vault全体のscan・
 * 月全体のbackfillは行わない——実際にユーザーがその日を開いた時だけ、fallbackで
 * 取得済みのデータ（追加のMarkdown readなし）からv2 entryを組み立て、その日だけを
 * 月Indexへ永続化する（lazy upgrade）。次回以降、アプリを再読み込みしてもその日は
 * v2として即座に表示される。
 *
 * 詳細表示（Conversationの本文turns、通常Memory/Reflectionの本文content）は、
 * 一覧行がタップされた時だけ、その1件分のMarkdownを読む。
 */
export default function HistoryPanel({
  onClose,
  onOpenSettings,
  vaultHandle,
  initialMemoryId,
  refreshToken,
  sessionCapturedMemories = [],
}: {
  onClose: () => void;
  /**
   * 実機不具合対応（原則B）：外部変更によりdetailが開けない（`detailUnavailable`）
   * 状態のとき、案内メッセージから直接設定画面（「Vaultを再同期」がある場所）へ
   * 遷移するための導線。渡されなければボタン自体を出さない（後方互換のoptional）。
   */
  onOpenSettings?: () => void;
  /**
   * ChatScreen.tsx側の既存Vault state（変更なし）をそのまま渡してもらうだけ。
   * このコンポーネント自身はVault切替ロジックを一切持たない——propが変わった
   * （＝別Vaultへ切り替わった）ことだけを検知して、表示状態を作り直す。
   */
  vaultHandle: FileSystemDirectoryHandle | null;
  /** 「記憶しました」カードの「詳細を見る」から開かれた場合のみ渡される。渡された場合は
   * 今日の日付を開いた上で、該当するMemoryObjectの詳細を直接開く。 */
  initialMemoryId?: string;
  /** 手動restore等でVault内容がIndexedDBへ反映された場合に、ChatScreen側で
   * インクリメントされるカウンタ。渡された場合、現在表示中の月・日を読み直すきっかけに
   * 使う（値自体に意味は無い）。 */
  refreshToken?: number;
  /**
   * 「今日」だけの安全な例外的マージ用（Step 1で検討した設計の、必要最小限の実装）。
   * Vault write（`awaitVaultSync=false`）が完了する前でも、ユーザー操作の完了と
   * 同時にIndexedDBへは既に保存されているCapture結果（ChatScreen.tsxの
   * `sessionCapturedMemories` stateをそのまま渡してもらう）。IndexedDBを新たに
   * 読み込むことはせず、既に手元にあるReact stateを描画時にマージするだけ
   * （IndexedDB全件取得は行わない。今日の日付のものだけを対象にidで重複排除する）。
   */
  sessionCapturedMemories?: MemoryObject[];
}) {
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<string | null>(todayKey());
  const [selectedMemory, setSelectedMemory] = useState<MemoryObject | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const [monthIndex, setMonthIndex] = useState<HistoryMonthIndex | null>(null);
  const [monthLoading, setMonthLoading] = useState(true);
  const [conversationRows, setConversationRows] = useState<ConversationRow[]>([]);
  const [memoryRows, setMemoryRows] = useState<MemoryRow[]>([]);
  const [dayLoading, setDayLoading] = useState(false);
  /** 一覧行タップ時のオンデマンド詳細読み込み中だけtrue（v2の日、または本体未読の行）。 */
  const [detailLoading, setDetailLoading] = useState(false);
  /**
   * 実機不具合対応（原則B）：一覧行をタップしたが本体を読めなかった場合にtrue。
   * History上には行として残っている（存在した記録）にもかかわらず読めない場合、
   * 無言で何も起きなかったように見せず、「外部で変更された可能性があるため
   * Vaultを再同期してください」という案内を表示する（技術用語は出さない）。
   */
  const [detailUnavailable, setDetailUnavailable] = useState(false);

  // race対策：月Index読み込み・日付詳細読み込み・詳細（Conversation/Memory本体）読み込み
  // それぞれについて、呼び出しごとにインクリメントするリクエストID。resolve/reject時に
  // 「今も自分が最新の要求か」を確認してからsetStateすることで、月移動・日付切替・
  // Vault切替の後に旧readが遅れて完了しても新しい画面へ混入しない（H4のepoch/generation
  // のような大掛かりな仕組みは使わず、このコンポーネント内で完結する最小限の
  // cancellationトークン）。
  const monthRequestRef = useRef(0);
  const dayRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  // 同一History表示セッション（このコンポーネントがマウントされている間）だけの
  // 短期メモリキャッシュ。History Index・Vaultデータそのものを置き換えるものではなく、
  // 「A→B→A」のように同じ日を行き来した際にVault I/Oを省略するためだけの一時キャッシュ。
  // アンマウントで自然に消える（この変数自体がuseRefの初期値として再生成される）。
  const dayCacheRef = useRef<Map<string, DayCacheEntry>>(new Map());
  // 現在選択中の日について、日付詳細の実読み込みeffectを走らせる必要が無い
  // （＝dayCacheRefにヒットした、またはvaultHandle/selectedDayが無い）ことを示す
  // フラグ。日付リセットeffectが同期的に設定し、直後に同一コミット内で走る
  // 読み込みeffectがこれを見て自身のfetchを省略する。
  const skipDayFetchRef = useRef(false);
  // vaultHandleが実際に変わった（別Vaultへ切替）ことを検知するためだけの参照。
  const previousVaultHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  // Vault切替を検知するたびに増やす、このコンポーネント内だけの世代カウンタ。
  // 切替直後、リセットしたviewYear/viewMonthへReact stateが追いつくまでの間に
  // 同じ月Indexを2回読んでしまわないようにするための重複排除キー
  // （`${vaultGeneration}:${year}-${month}:${refreshToken}`）に使う。
  const vaultGenerationRef = useRef(0);
  const lastMonthFetchKeyRef = useRef<string>("");
  // initialMemoryIdは「一度だけ」該当日を見つけて開く用途のため、既に処理済みなら
  // 再度自動オープンしない（ユーザーが手動で別のMemoryを開いた後に、古いターゲットへ
  // 引き戻さないため）。vaultHandleが変わった場合はpropの値へ再度リセットする。
  const pendingInitialMemoryIdRef = useRef<string | undefined>(initialMemoryId);
  // dayCacheRefを「vaultHandleまたはrefreshTokenが実際に変わった時」だけ丸ごと破棄する
  // ための直前値の記録（selectedDayだけが変わった場合はキャッシュを破棄しない——
  // それこそがこのキャッシュの存在意義であるA→B→Aの再訪高速化のため）。
  const previousVaultHandleForCacheRef = useRef<FileSystemDirectoryHandle | null>(null);
  const previousRefreshTokenForCacheRef = useRef<number | undefined>(refreshToken);

  /**
   * Vault境界の安全性＋月Index二重読込の解消：vaultHandleが変わった（別Vaultへ切替）
   * 瞬間、旧Vaultの表示が一切残らないよう月・詳細選択をリセットしてから、今月の
   * month indexを読み直す。
   *
   * Vault切替を検知した場合は「今月」をこのeffectの実行内でローカル変数として直接
   * 計算し、setViewYear/setViewMonth（stateへの反映は次のレンダーまで遅れる）を
   * 待たずに、その場でその月のmonth indexを読む。setViewYear/setViewMonthの反映に
   * より同じ内容でこのeffectが再度呼ばれても、`lastMonthFetchKeyRef`（vault世代＋
   * 年月＋refreshTokenの組）で重複読込を検知して読み直さない。通常の前月/翌月移動・
   * refreshTokenによる再読込はキーが変わるため従来通り正しく再読込される。
   *
   * H4のepoch/world isolationには一切触れない——このコンポーネントはVault切替の
   * 成否判定を行わず、ChatScreen.tsx側で既に確定した`vaultHandle`をそのまま信頼する。
   */
  useEffect(() => {
    if (!vaultHandle) {
      previousVaultHandleRef.current = null;
      lastMonthFetchKeyRef.current = "";
      monthRequestRef.current += 1;
      setMonthIndex(null);
      setMonthLoading(false);
      return;
    }

    const vaultChanged = previousVaultHandleRef.current !== vaultHandle;
    previousVaultHandleRef.current = vaultHandle;

    let targetYear = viewYear;
    let targetMonth = viewMonth;

    if (vaultChanged) {
      vaultGenerationRef.current += 1;
      const now = new Date();
      targetYear = now.getFullYear();
      targetMonth = now.getMonth() + 1;
      setSelectedDay(todayKey());
      setSelectedMemory(null);
      setSelectedConversation(null);
      setDetailUnavailable(false);
      setMonthIndex(null);
      pendingInitialMemoryIdRef.current = initialMemoryId;
      if (targetYear !== viewYear || targetMonth !== viewMonth) {
        setViewYear(targetYear);
        setViewMonth(targetMonth);
      }
    }

    const fetchKey = `${vaultGenerationRef.current}:${targetYear}-${targetMonth}:${refreshToken ?? 0}`;
    if (fetchKey === lastMonthFetchKeyRef.current) return; // 直前と同じ内容の重複読込を防ぐ
    lastMonthFetchKeyRef.current = fetchKey;

    const requestId = ++monthRequestRef.current;
    const handle = vaultHandle;
    setMonthLoading(true);
    readHistoryMonthIndex(handle, monthKeyOf(targetYear, targetMonth))
      .then((index) => {
        if (monthRequestRef.current !== requestId) return; // 月移動／Vault切替で既に無効化された要求
        setMonthIndex(index);
        setMonthLoading(false);
      })
      .catch((error) => {
        if (monthRequestRef.current !== requestId) return;
        console.error("Failed to load history month index", error);
        setMonthIndex(null);
        setMonthLoading(false);
      });
    // initialMemoryIdは「vaultHandleが変わった時にリセットする」という目的だけで
    // 参照しており、依存に含めるとinitialMemoryIdの変化のたびに月・日表示まで
    // リセットしてしまうため、意図的に依存配列から外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultHandle, viewYear, viewMonth, refreshToken]);

  /**
   * 日付詳細読み込み・その1（リセット＋キャッシュ確認）：選択日／Vault／refreshTokenが
   * 変わるたびに走る。
   *
   * キャッシュ（`dayCacheRef`、同一History表示セッション内だけの短期メモリキャッシュ。
   * History Index・Vaultデータそのものを置き換えるものではない）は、vaultHandleまたは
   * refreshTokenが実際に変わった場合だけ丸ごと破棄する（selectedDayだけの変化では
   * 破棄しない——これがA→B→Aの再訪でVault I/Oを省略できる理由そのもの）。
   *
   * 選択日がキャッシュにヒットすれば、Vaultへは一切アクセスせずその場でstateを復元し、
   * `dayLoading`をtrueへ戻さない（要求通り、既読日の再表示は即時）。ヒットしなければ
   * 状態をクリアしてdayLoadingをtrueにし、`skipDayFetchRef`をfalseにして下の
   * 読み込みeffectに実際の解決（v2直読み、またはv1 fallback）を行わせる。
   */
  useEffect(() => {
    const cacheInvalidated =
      previousVaultHandleForCacheRef.current !== vaultHandle || previousRefreshTokenForCacheRef.current !== refreshToken;
    previousVaultHandleForCacheRef.current = vaultHandle;
    previousRefreshTokenForCacheRef.current = refreshToken;
    if (cacheInvalidated) {
      dayCacheRef.current.clear();
    }

    dayRequestRef.current += 1;
    detailRequestRef.current += 1; // 進行中のオンデマンド詳細readも無効化する

    if (!vaultHandle || !selectedDay) {
      skipDayFetchRef.current = true;
      setConversationRows([]);
      setMemoryRows([]);
      setDayLoading(false);
      return;
    }

    const cached = dayCacheRef.current.get(selectedDay);
    if (cached) {
      skipDayFetchRef.current = true;
      setConversationRows(cached.conversationRows);
      setMemoryRows(cached.memoryRows);
      setDayLoading(false);
      return;
    }

    skipDayFetchRef.current = false;
    setConversationRows([]);
    setMemoryRows([]);
    setDayLoading(true);
  }, [vaultHandle, selectedDay, refreshToken]);

  /**
   * 日付詳細読み込み・その2（解決）：`monthIndex.days[selectedDay]`がHistory Index v2
   * 形状（`isHistoryDayIndexV2`）であれば、Vault本体を一切読まずに一覧を組み立てる
   * （Conversation/Reflection/通常MemoryのMarkdownはいずれも読まない）。
   *
   * v1形状（既存Vaultで、まだ一度も開かれていない日）またはエントリ未登録の場合は、
   * 従来通りid経由でMarkdown本体を読むfallbackを行う。fallback完了後、取得済みの
   * データ（追加のMarkdown readを一切行わない）からv2 entryを組み立て、その日だけ
   * `upgradeHistoryDayToV2`でfire-and-forgetに永続化する（lazy upgrade）。失敗しても
   * console.errorに残すだけで、既に確定している表示（fallbackの結果）には影響させない。
   *
   * monthLoading完了を待つ（月Indexが無いとv1/v2の判定自体ができないため）。
   * `skipDayFetchRef`がtrue（キャッシュヒット、またはvaultHandle/selectedDayが無い）
   * の場合は何もしない。
   */
  useEffect(() => {
    if (!vaultHandle || !selectedDay || monthLoading || skipDayFetchRef.current) return;
    const requestId = dayRequestRef.current;
    const handle = vaultHandle;
    const day = selectedDay;
    const dayEntry = monthIndex?.days[day];
    const monthIndexAtStart = monthIndex;

    if (dayEntry && isHistoryDayIndexV2(dayEntry)) {
      // v2：Vault本体read 0回で一覧を構築する。
      const conversations: ConversationRow[] = dayEntry.conversations.map((c) => ({
        id: c.id,
        modeLabel: c.mode === "diary" ? "日記" : "会話",
        turnCount: c.turnCount,
      }));
      const memories: MemoryRow[] = [
        ...dayEntry.normalMemories.map((m) => ({
          id: m.id,
          types: m.types,
          preview: m.preview,
          createdAt: m.createdAt,
          origin: "normal" as const,
        })),
        ...dayEntry.reflections.map((m) => ({
          id: m.id,
          types: m.types,
          preview: m.preview,
          createdAt: m.createdAt,
          origin: "reflection" as const,
        })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setConversationRows(conversations);
      setMemoryRows(memories);
      dayCacheRef.current.set(day, { conversationRows: conversations, memoryRows: memories });
      setDayLoading(false);
      return;
    }

    // v1（またはエントリ未登録）：既存のfallback経路で本体を直接読む。
    const reflectionIds = dayEntry?.reflectionIds ?? [];
    const conversationIds = dayEntry?.conversationIds ?? [];

    (async () => {
      try {
        const [memoriesDir, conversationsDir] = await Promise.all([
          reflectionIds.length > 0
            ? handle.getDirectoryHandle("Memories", { create: false }).catch(() => undefined)
            : Promise.resolve(undefined),
          conversationIds.length > 0
            ? handle.getDirectoryHandle("Conversations", { create: false }).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        const [normalMemoriesFull, reflectionResults, conversationResults] = await Promise.all([
          readMemoriesForDay(handle, day),
          Promise.all(reflectionIds.map((id) => readReflectionById(handle, id, day, memoriesDir))),
          Promise.all(conversationIds.map((id) => readConversationById(handle, id, day, conversationsDir))),
        ]);
        if (dayRequestRef.current !== requestId) return; // 日付切替／Vault切替で既に無効化された要求

        const reflectionsFull = reflectionResults.filter((memory): memory is MemoryObject => memory !== null);
        const conversationsFull = conversationResults.filter(
          (conversation): conversation is Conversation => conversation !== null
        );

        const conversationRowsNext: ConversationRow[] = conversationsFull.map((c) => ({
          id: c.id,
          modeLabel: personaModeLabel(c.persona),
          turnCount: c.turns.length,
          full: c,
        }));
        const memoryRowsNext: MemoryRow[] = [
          ...normalMemoriesFull.map((m) => ({
            id: m.id,
            types: m.types,
            preview: m.summary,
            createdAt: m.createdAt,
            origin: "normal" as const,
            full: m,
          })),
          ...reflectionsFull.map((m) => ({
            id: m.id,
            types: m.types,
            preview: m.summary,
            createdAt: m.createdAt,
            origin: "reflection" as const,
            full: m,
          })),
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        setConversationRows(conversationRowsNext);
        setMemoryRows(memoryRowsNext);
        dayCacheRef.current.set(day, { conversationRows: conversationRowsNext, memoryRows: memoryRowsNext });
        setDayLoading(false);

        // lazy upgrade：fallbackで既に取得済みのデータだけから組み立てる（追加read無し）。
        // v1エントリが元々存在した日、または（エントリ未登録でも）何かデータが
        // 見つかった日だけを対象にする——完全に空の日を新規に書き込む必要は無いため。
        const hadExistingEntry = !!dayEntry;
        const hasAnyData = conversationsFull.length > 0 || normalMemoriesFull.length > 0 || reflectionsFull.length > 0;
        if (hadExistingEntry || hasAnyData) {
          const v2Entry: HistoryDayIndexV2 = {
            conversations: conversationsFull.map((c) => ({
              id: c.id,
              mode: c.persona === "companion" ? "diary" : "conversation",
              turnCount: c.turns.length,
            })),
            normalMemories: normalMemoriesFull.map((m) => ({
              id: m.id,
              types: m.types,
              preview: truncateHistoryPreview(m.summary),
              createdAt: m.createdAt,
            })),
            reflections: reflectionsFull.map((m) => ({
              id: m.id,
              types: m.types,
              preview: truncateHistoryPreview(m.summary),
              createdAt: m.createdAt,
            })),
          };
          void upgradeHistoryDayToV2(handle, day, v2Entry)
            .then(() => {
              // monthIndex自体が（Vault切替・月移動・別のupgrade等で）既に別のものへ
              // 変わっていれば何もしない（stale patchを防ぐ。参照の一致で判定する）。
              setMonthIndex((current) => {
                if (current !== monthIndexAtStart || !current) return current;
                return { ...current, days: { ...current.days, [day]: v2Entry } };
              });
            })
            .catch((error) => {
              // 失敗してもHistory表示自体（既にfallbackで確定している表示）は
              // 失敗させない。次にこの日を開いた時、再度fallback→upgradeを試みる。
              console.error("[Tsumugi] failed to lazily upgrade history day index (display unaffected):", error);
            });
        }
      } catch (error) {
        if (dayRequestRef.current !== requestId) return;
        console.error("Failed to load day records", error);
        setConversationRows([]);
        setMemoryRows([]);
        setDayLoading(false);
      }
    })();
  }, [vaultHandle, selectedDay, monthIndex, monthLoading, refreshToken]);

  /**
   * 一覧行タップ時のオンデマンド詳細読み込み。`full`が既に設定済み（v1 fallbackで
   * 本体を読み終えている）ならその場で使い、追加のreadは発生させない。未設定
   * （v2の日、Vault本体read 0回で構築した行）の場合だけ、その1件分のMarkdownを読む。
   */
  async function openConversationRow(row: ConversationRow) {
    if (row.full) {
      setSelectedConversation(row.full);
      return;
    }
    if (!vaultHandle || !selectedDay) return;
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailUnavailable(false);
    try {
      const conversation = await readConversationById(vaultHandle, row.id, selectedDay);
      if (detailRequestRef.current !== requestId) return;
      // 実機不具合対応（原則B）：一覧に行として存在する（＝過去に記録された）
      // Conversationであるにもかかわらず本体が読めない場合、無言で何も起きな
      // かったように見せない。外部でMarkdownが移動・編集・削除された等の理由で
      // Vault Registryが安全のため読み取りを保留している可能性が高いため。
      if (conversation) setSelectedConversation(conversation);
      else setDetailUnavailable(true);
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }

  async function openMemoryRow(row: MemoryRow) {
    if (row.full) {
      setSelectedMemory(row.full);
      return;
    }
    if (!vaultHandle || !selectedDay) return;
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailUnavailable(false);
    try {
      if (row.origin === "reflection") {
        const memory = await readReflectionById(vaultHandle, row.id, selectedDay);
        if (detailRequestRef.current !== requestId) return;
        if (memory) setSelectedMemory(memory);
        else setDetailUnavailable(true);
      } else {
        // 通常Memoryは1日1Markdown（複数件統合）のため、1件だけを取り出すファイル形式が
        // 無い。その日のday-fileを1回読み、対象idをfindする（既存のreadMemoriesForDay
        // を再利用するだけで、新しいvault.ts関数は追加しない）。
        const dayMemories = await readMemoriesForDay(vaultHandle, selectedDay);
        if (detailRequestRef.current !== requestId) return;
        const memory = dayMemories.find((m) => m.id === row.id);
        if (memory) setSelectedMemory(memory);
        else setDetailUnavailable(true);
      }
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }

  /**
   * 「記憶しました」カードの「詳細を見る」から開かれた場合の自動オープン。
   * `memoryRows`が確定して`dayLoading`がfalseになった時点で、対象idの行を探し
   * オンデマンド詳細読み込み（`openMemoryRow`、v1 fallback済みなら追加read無し）を行う。
   */
  useEffect(() => {
    if (dayLoading) return;
    if (!pendingInitialMemoryIdRef.current) return;
    const targetId = pendingInitialMemoryIdRef.current;
    pendingInitialMemoryIdRef.current = undefined;
    const row = memoryRows.find((memoryRow) => memoryRow.id === targetId);
    if (row) {
      void openMemoryRow(row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayLoading, memoryRows]);

  /**
   * 「今日」だけの安全な例外的マージ：Vault write未完了でも、既にIndexedDBへ保存済み
   * （＝ユーザー操作としては完了している）今回セッションのCapture結果を、選択日が
   * 今日の場合にだけ描画時にマージする。IndexedDBへの新規アクセスは一切発生しない
   * （sessionCapturedMemoriesは既にChatScreen.tsx側が保持しているReact stateを
   * そのまま受け取るだけ）。idで重複排除するため、Vault側読み込みが追いついた後に
   * 二重表示にはならない。
   */
  const displayedMemoryRows = useMemo(() => {
    if (selectedDay !== todayKey() || sessionCapturedMemories.length === 0) {
      return memoryRows;
    }
    const seenIds = new Set(memoryRows.map((row) => row.id));
    const todaysSessionRows: MemoryRow[] = sessionCapturedMemories
      .filter((memory) => memory.date.slice(0, 10) === selectedDay && !seenIds.has(memory.id))
      .map((memory) => ({
        id: memory.id,
        types: memory.types,
        preview: memory.summary,
        createdAt: memory.createdAt,
        origin: "normal" as const,
        full: memory,
      }));
    if (todaysSessionRows.length === 0) return memoryRows;
    return [...memoryRows, ...todaysSessionRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [memoryRows, selectedDay, sessionCapturedMemories]);

  const hasSessionRecordToday = useMemo(
    () => sessionCapturedMemories.some((memory) => memory.date.slice(0, 10) === todayKey()),
    [sessionCapturedMemories]
  );

  function dayHasRecord(day: string): boolean {
    const entry = monthIndex?.days[day];
    if (entry) {
      const hasEntryRecord = isHistoryDayIndexV2(entry)
        ? entry.conversations.length > 0 || entry.normalMemories.length > 0 || entry.reflections.length > 0
        : entry.conversationIds.length > 0 || entry.memoryCount > 0;
      if (hasEntryRecord) return true;
    }
    return day === todayKey() && hasSessionRecordToday;
  }

  // Memoryの由来会話（日時・モード）を一言添えるための索引。既に本体を読み終えている
  // （`full`が設定済みの）Conversationからだけ作る（追加のVault読み込みは行わない。
  // v2の日で由来会話がまだ詳細表示されていない場合は、この一覧に無いため表示を省略
  // する——UIの完全再現ではなく「その日の記録を確認できる」ことを優先する方針）。
  const conversationById = new Map(
    conversationRows
      .filter((row): row is ConversationRow & { full: Conversation } => !!row.full)
      .map((row) => [row.id, row.full])
  );

  const monthGrid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  /**
   * 月を移動する際、選択中の日付を必ず解除する（重要：データ整合性バグ対応）。
   *
   * 以前はselectedDayを保持したまま月だけ移動できたため、「新しいmonthIndex」と
   * 「古い月のselectedDay」という組み合わせが一時的に成立し得た。この状態で
   * 「日付詳細・その2（解決）」effectが発火すると、新しい月のmonthIndexの中に
   * 古い日付のdayEntryを探すことになり、ほぼ確実にundefinedとなってv1 fallback
   * 経路（readMemoriesForDay等）へ進んでしまう。fallback自体はmonthをまたいで
   * 直接day-fileを読むため一部のデータ（通常Memory）だけが見つかることがあり、
   * その不完全な結果（Conversation/Reflectionは常に空）でlazy upgradeが実行される
   * と、その日が本来v1で持っていたconversationIds/reflectionIdsを失った、
   * 空のconversations/reflectionsを持つv2 entryとしてHistory Indexへ書き込まれて
   * しまう。`isHistoryDayIndexV2`は一度v2になったentryを二度とv1 fallbackへ
   * 戻さないため、この誤ったv2化は通常の操作では二度と修復されない
   * （データ整合性バグ）。
   *
   * ここでselectedDayをnullにすることで、「日付詳細・その2」effectの冒頭ガード
   * （`if (!vaultHandle || !selectedDay || ...) return;`）が即座に働き、上記の
   * 誤ったfallback読み込み・誤ったlazy upgradeは一切発生しなくなる。
   * conversationRows/memoryRows/dayLoadingは、selectedDayを依存に持つ既存の
   * 「日付詳細・その1（リセット＋キャッシュ確認）」effectがselectedDay===nullの
   * 分岐で自動的にクリアするため、ここで重複して手動クリアはしない。
   * selectedMemory/selectedConversationは、selectedDayの変化だけでは自動的に
   * クリアされる既存effectが無い（表示は`{selectedDay && (...)}`のゲートで
   * 隠れるだけでstate自体は残る）ため、`selectDay()`と同様にここで明示的に
   * クリアする。
   */
  function goToMonth(delta: number) {
    const next = addMonths(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
    setSelectedDay(null);
    setSelectedMemory(null);
    setSelectedConversation(null);
    setDetailUnavailable(false);
  }

  function selectDay(day: string) {
    setSelectedDay(day);
    setSelectedMemory(null);
    setSelectedConversation(null);
    setDetailUnavailable(false);
    // 前の日付の表示が一瞬でも残らないよう、ここで即座に更新する（実際の
    // requestId発行・skipDayFetchRefの確定は、直後に走るreset effect
    // （selectedDayの変化を検知して発火する）が同じ判定を行う）。
    const cached = dayCacheRef.current.get(day);
    if (cached) {
      setConversationRows(cached.conversationRows);
      setMemoryRows(cached.memoryRows);
      setDayLoading(false);
    } else {
      setConversationRows([]);
      setMemoryRows([]);
      setDayLoading(true);
    }
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex h-[85dvh] w-full max-w-md flex-col overflow-hidden">
        {/*
          レイアウト安定化（案B）：外枠の高さを固定（h-[85dvh]）＋overflow-hiddenにした
          上で、内部をflex columnで「上段＝見出し・月移動・曜日・カレンダーグリッド
          （shrink-0、自然な高さのまま）」「下段＝選択日の履歴（flex-1＋min-h-0＋
          overflow-y-auto、この部分だけが独立してスクロールする）」の2領域に分割する。
          カレンダー本体は一切スクロールせず、外枠の高さも履歴の長さに関わらず常に
          一定のため、カレンダー位置が画面内で動かない。
        */}
        <div className="flex shrink-0 flex-col gap-5">
          <div className="flex items-center justify-between">
            <p className="text-lg text-stone-800 dark:text-stone-100">これまでの記憶</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
            >
              閉じる
            </button>
          </div>

          {!vaultHandle ? (
            <p className="text-sm text-stone-400 dark:text-stone-500">保存先が接続されていません。</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => goToMonth(-1)}
                  className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  前月
                </button>
                <p className="text-sm text-stone-700 dark:text-stone-300">
                  {viewYear}年{viewMonth}月
                </p>
                <button
                  type="button"
                  onClick={() => goToMonth(1)}
                  className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  翌月
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-stone-400 dark:text-stone-500">
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>

              <div className="flex flex-col gap-1">
                {monthGrid.map((week, weekIndex) => (
                  <div key={weekIndex} className="grid grid-cols-7 gap-1">
                    {week.map((day, dayIndex) => {
                      if (!day) {
                        return <div key={dayIndex} />;
                      }
                      const dayNumber = Number(day.slice(8, 10));
                      const isSelected = day === selectedDay;
                      const hasRecord = dayHasRecord(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => selectDay(day)}
                          className={`flex flex-col items-center gap-0.5 rounded-xl border px-1 py-1.5 text-xs transition ${
                            isSelected
                              ? "border-stone-800 bg-stone-800 text-stone-50 dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900"
                              : "border-transparent text-stone-600 hover:bg-stone-900/5 dark:text-stone-300 dark:hover:bg-white/5"
                          }`}
                        >
                          <span>{dayNumber}</span>
                          <span
                            className={`h-1 w-1 rounded-full ${
                              hasRecord ? (isSelected ? "bg-stone-50 dark:bg-stone-900" : "bg-stone-500 dark:bg-stone-400") : ""
                            }`}
                          />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {vaultHandle && selectedDay && (
          <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-3 border-t border-black/5 pt-4 dark:border-white/10">
              <p className="text-xs text-stone-400 dark:text-stone-500">{selectedDay}</p>

              {monthLoading || dayLoading || detailLoading ? (
                <p className="text-sm text-stone-400 dark:text-stone-500">読み込んでいます…</p>
              ) : detailUnavailable ? (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => setDetailUnavailable(false)}
                    className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                  >
                    戻る
                  </button>
                  <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-4 py-3 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
                    <p>この記録を開くために、保存先の確認が必要です。</p>
                    <p className="text-xs text-stone-500 dark:text-stone-400">設定から「Vaultを再同期」してください。</p>
                    {onOpenSettings && (
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="self-start rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                      >
                        設定を開く
                      </button>
                    )}
                  </div>
                </div>
              ) : selectedConversation ? (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedConversation(null)}
                    className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                  >
                    戻る
                  </button>
                  <p className="text-xs text-stone-400 dark:text-stone-500">
                    {selectedConversation.startedAt.slice(0, 10)}・{personaModeLabel(selectedConversation.persona)}
                  </p>
                  <div className="flex flex-col gap-3">
                    {selectedConversation.turns.map((turn, index) => (
                      <HistoryTurnBubble key={index} turn={turn} />
                    ))}
                  </div>
                </div>
              ) : selectedMemory ? (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedMemory(null)}
                    className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                  >
                    戻る
                  </button>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                    <span>{selectedMemory.date.slice(0, 10)}</span>
                    {selectedMemory.types.map((type) => (
                      <span
                        key={type}
                        className="rounded-full border border-stone-300/60 px-2 py-0.5 dark:border-stone-600/60"
                      >
                        {MEMORY_TYPE_LABEL[type] ?? type}
                      </span>
                    ))}
                  </div>
                  <p className="text-base text-stone-800 dark:text-stone-100">{selectedMemory.summary}</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
                    {selectedMemory.content}
                  </p>
                  {selectedMemory.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {selectedMemory.keywords.map((keyword) => (
                        <span
                          key={keyword}
                          className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 dark:border-stone-600/60 dark:text-stone-400"
                        >
                          {keyword}
                        </span>
                      ))}
                    </div>
                  )}
                  {selectedMemory.conversationId &&
                    (() => {
                      const origin = conversationById.get(selectedMemory.conversationId);
                      if (!origin) return null;
                      return (
                        <p className="border-t border-black/5 pt-3 text-xs text-stone-400 dark:border-white/10 dark:text-stone-500">
                          由来：{origin.startedAt.slice(0, 10)}の{personaModeLabel(origin.persona)}の会話
                        </p>
                      );
                    })()}
                </div>
              ) : conversationRows.length === 0 && displayedMemoryRows.length === 0 ? (
                <p className="text-sm text-stone-400 dark:text-stone-500">この日の記録はありません。</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {conversationRows.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-stone-400 dark:text-stone-500">会話</p>
                      {conversationRows.map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => void openConversationRow(row)}
                          className="flex items-center justify-between gap-4 rounded-2xl border border-stone-300/70 px-4 py-3 text-left text-sm text-stone-700 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-300 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                        >
                          <span>{row.modeLabel}</span>
                          <span className="shrink-0 text-[11px] text-stone-400 dark:text-stone-500">
                            {row.turnCount}件のメッセージ
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {displayedMemoryRows.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-stone-400 dark:text-stone-500">記憶</p>
                      {displayedMemoryRows.map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => void openMemoryRow(row)}
                          className="flex flex-col gap-1 rounded-2xl border border-stone-300/70 px-4 py-3 text-left transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                        >
                          <span className="text-sm text-stone-700 dark:text-stone-300">{row.preview}</span>
                          <span className="flex flex-wrap items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                            {row.types.map((type) => (
                              <span
                                key={type}
                                className="rounded-full border border-stone-300/60 px-2 py-0.5 dark:border-stone-600/60"
                              >
                                {MEMORY_TYPE_LABEL[type] ?? type}
                              </span>
                            ))}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ChatScreen.tsxのTurnBubbleと同じ見た目の吹き出し。ChatScreen.tsxはHistoryPanelを
 * importしているため、循環importを避けるためにここでは同じ見た目を再実装する
 * （ロジックを持たない純粋な表示コンポーネントで、双方の見た目は意図的に揃えている）。
 */
function HistoryTurnBubble({ turn }: { turn: ConversationTurn }) {
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
