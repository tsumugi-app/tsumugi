"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readHistoryMonthIndex, readMemoriesForDay, readReflectionById, readConversationById } from "@/lib/vault";
import type { HistoryMonthIndex } from "@/lib/vault";
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

/** ChatScreen.tsxのPERSONASと同じラベル（値の重複は許容し、循環import・新規ファイルを避ける）。 */
const PERSONA_LABEL: Record<Persona, string> = {
  companion: "日記",
  coach: "探究",
  analyst: "相談・創造",
};

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

interface DayRecords {
  conversations: Conversation[];
  /** 通常Memory（day-file統合分）とReflection Summary（1record1file）を統合済み。 */
  memories: MemoryObject[];
}

/**
 * 「いつ何を話したかを見る場所」という時間軸中心のHistory UI（Vault読込方式の
 * 再設計、Step 3）。
 *
 * 以前はIndexedDBの`getAllMemoryObjects()`/`getAllConversations()`を毎回全件取得して
 * 縦長一覧を作っていたが、この方式はVault内のデータ量に読み込み量が比例してしまう
 * （本調査スレッドのAndroid実機性能問題の根本原因）。今回からは、Vault内
 * `.tsumugi/history/YYYY-MM.json`（月Index、`src/lib/vault.ts`のStep 1で追加）だけを
 * 読んでカレンダーの「印」を出し、日付をタップした瞬間だけ、その日に必要な
 * Markdown（`Memories/YYYY-MM-DD.md`・reflectionIds/conversationIdsのファイル）を
 * 読む。IndexedDB全件取得・Vault全体のfull scanはHistory表示のためには一切行わない
 * （full scan呼び出し自体の停止はStep 4で行う。このコンポーネント自身は今回の
 * 変更時点で既にIndexedDB全件取得を行わない設計になっている）。
 *
 * 旧「日記／Memory／会話」タブは、カレンダー中心の設計と競合するため今回は維持しない
 * （β段階のため、将来のシンプルな構造を優先する）。
 */
export default function HistoryPanel({
  onClose,
  vaultHandle,
  initialMemoryId,
  refreshToken,
  sessionCapturedMemories = [],
}: {
  onClose: () => void;
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
  // 日付詳細は「通常Memory（day-file、month indexに依存しない）」と
  // 「Reflection／Conversation（month indexのreflectionIds/conversationIdsに依存）」を
  // 別々に読み、2つのstateを`dayRecords`（下のuseMemo）で安全にマージする
  // （読込順序の見直し：通常MemoryはmonthLoadingを待たずに先行開始する）。
  const [normalMemories, setNormalMemories] = useState<MemoryObject[]>([]);
  const [extraDayRecords, setExtraDayRecords] = useState<{ conversations: Conversation[]; reflections: MemoryObject[] }>(
    { conversations: [], reflections: [] }
  );
  const [dayLoading, setDayLoading] = useState(false);

  // race対策：月Index読み込み・日付詳細読み込み（通常Memory／Reflection・Conversationの
  // 両方）それぞれについて、呼び出しごとにインクリメントするリクエストID。resolve/reject
  // 時に「今も自分が最新の要求か」を確認してからsetStateすることで、月移動・日付切替・
  // Vault切替の後に旧readが遅れて完了しても新しい画面へ混入しない（H4のepoch/generation
  // のような大掛かりな仕組みは使わず、このコンポーネント内で完結する最小限の
  // cancellationトークン）。
  const monthRequestRef = useRef(0);
  const dayRequestRef = useRef(0);
  // 通常Memory・Reflection/Conversationという2つの独立した読み込みのうち、まだ完了して
  // いない件数。0になった時点で初めてdayLoadingをfalseにする（どちらか一方だけ終わった
  // 時点でロード完了扱いにしない）。
  const dayPartsPendingRef = useRef(0);
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

  /**
   * Vault境界の安全性＋月Index二重読込の解消：vaultHandleが変わった（別Vaultへ切替）
   * 瞬間、旧Vaultの表示が一切残らないよう月・詳細選択をリセットしてから、今月の
   * month indexを読み直す。
   *
   * 以前はこの「リセット」と「month index読込」を2つの別々のuseEffectに分けていた
   * ため、Vault切替時に「リセット前（切替前に見ていた月）のmonth indexを1回読む→
   * リセット後のsetViewYear/setViewMonthが反映された次のレンダーで、今月のmonth
   * indexをもう1回読む」という2回の実読込（1回目はrequestIdの不一致で結果こそ
   * 捨てられるが、ファイル読込I/O自体は発生する）が起きていた。
   *
   * ここでは1つのeffectに統合し、Vault切替を検知した場合は「今月」をこのeffectの
   * 実行内でローカル変数として直接計算し、setViewYear/setViewMonth（stateへの反映は
   * 次のレンダーまで遅れる）を待たずに、その場でその月のmonth indexを読む。
   * setViewYear/setViewMonthの反映により同じ内容でこのeffectが再度呼ばれても、
   * `lastMonthFetchKeyRef`（vault世代＋年月＋refreshTokenの組）で重複読込を検知して
   * 読み直さない。通常の前月/翌月移動・refreshTokenによる再読込はキーが変わるため
   * 従来通り正しく再読込される。
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
   * 日付詳細読み込み・その1（リセット）：選択日／Vaultが変わるたびに、通常Memory・
   * Reflection/Conversationの両方の状態をクリアし、2件とも完了するまでdayLoadingを
   * trueに保つ（`dayPartsPendingRef`で管理）。実際の読込は下の2つのeffectがそれぞれ
   * 独立して行う。
   */
  useEffect(() => {
    dayRequestRef.current += 1;
    setNormalMemories([]);
    setExtraDayRecords({ conversations: [], reflections: [] });
    if (!vaultHandle || !selectedDay) {
      dayPartsPendingRef.current = 0;
      setDayLoading(false);
      return;
    }
    dayPartsPendingRef.current = 2;
    setDayLoading(true);
  }, [vaultHandle, selectedDay]);

  /**
   * 日付詳細読み込み・その2（通常Memory）：`Memories/YYYY-MM-DD.md`はmonth index
   * （reflectionIds/conversationIds）に一切依存しないため、選択日が確定した時点で
   * month indexの読込完了（monthLoading）を待たずに開始する。
   */
  useEffect(() => {
    if (!vaultHandle || !selectedDay) return;
    const requestId = dayRequestRef.current;
    const handle = vaultHandle;
    const day = selectedDay;
    readMemoriesForDay(handle, day)
      .then((memories) => {
        if (dayRequestRef.current !== requestId) return; // 日付切替／Vault切替で既に無効化された要求
        setNormalMemories(memories);
        dayPartsPendingRef.current = Math.max(0, dayPartsPendingRef.current - 1);
        if (dayPartsPendingRef.current === 0) setDayLoading(false);
      })
      .catch((error) => {
        if (dayRequestRef.current !== requestId) return;
        console.error("Failed to load memories for day", error);
        setNormalMemories([]);
        dayPartsPendingRef.current = Math.max(0, dayPartsPendingRef.current - 1);
        if (dayPartsPendingRef.current === 0) setDayLoading(false);
      });
  }, [vaultHandle, selectedDay, refreshToken]);

  /**
   * 日付詳細読み込み・その3（Reflection／Conversation）：月Indexの`reflectionIds`/
   * `conversationIds`が判明してから（monthLoading完了後）だけ読む。同じ日に複数件
   * ある場合、`Memories`/`Conversations`ディレクトリハンドルをそれぞれ1回だけ
   * （必要な場合のみ）解決し、各readへ使い回す（毎item`getDirectoryHandle`を
   * 取り直さない）。
   */
  useEffect(() => {
    if (!vaultHandle || !selectedDay || monthLoading) return;
    const requestId = dayRequestRef.current;
    const handle = vaultHandle;
    const day = selectedDay;
    const dayEntry = monthIndex?.days[day];
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
        const [reflectionResults, conversationResults] = await Promise.all([
          Promise.all(reflectionIds.map((id) => readReflectionById(handle, id, day, memoriesDir))),
          Promise.all(conversationIds.map((id) => readConversationById(handle, id, day, conversationsDir))),
        ]);
        if (dayRequestRef.current !== requestId) return; // 日付切替／Vault切替で既に無効化された要求
        const reflections = reflectionResults.filter((memory): memory is MemoryObject => memory !== null);
        const conversations = conversationResults.filter(
          (conversation): conversation is Conversation => conversation !== null
        );
        setExtraDayRecords({ conversations, reflections });
        dayPartsPendingRef.current = Math.max(0, dayPartsPendingRef.current - 1);
        if (dayPartsPendingRef.current === 0) setDayLoading(false);
      } catch (error) {
        if (dayRequestRef.current !== requestId) return;
        console.error("Failed to load day records", error);
        setExtraDayRecords({ conversations: [], reflections: [] });
        dayPartsPendingRef.current = Math.max(0, dayPartsPendingRef.current - 1);
        if (dayPartsPendingRef.current === 0) setDayLoading(false);
      }
    })();
  }, [vaultHandle, selectedDay, monthIndex, monthLoading, refreshToken]);

  /**
   * 通常MemoryとReflectionを安全にマージする（別々のeffectが別々のタイミングで完了
   * しても、常に最新の両方から作り直すため、片方だけの中途半端な状態が画面に出る
   * ことはない——実際に表示されるのは`dayLoading`がfalseになった後のみ）。idで
   * 重複排除してから統合する（同じrecordの二重表示を防ぐ、以前と同じロジック）。
   */
  const dayRecords = useMemo<DayRecords>(() => {
    const seenMemoryIds = new Set<string>();
    const memories: MemoryObject[] = [];
    for (const memory of [...normalMemories, ...extraDayRecords.reflections]) {
      if (seenMemoryIds.has(memory.id)) continue;
      seenMemoryIds.add(memory.id);
      memories.push(memory);
    }
    memories.sort((a, b) => a.date.localeCompare(b.date));
    return { conversations: extraDayRecords.conversations, memories };
  }, [normalMemories, extraDayRecords]);

  /**
   * 「記憶しました」カードの「詳細を見る」から開かれた場合の自動オープン。以前は
   * 単一の読込effect完了時にまとめて行っていたが、通常Memory／Reflection・
   * Conversationが別々のeffectに分かれたため、両方が完了して`dayLoading`がfalseに
   * なった時点でまとめて行う。
   */
  useEffect(() => {
    if (dayLoading) return;
    if (!pendingInitialMemoryIdRef.current) return;
    const target = dayRecords.memories.find((memory) => memory.id === pendingInitialMemoryIdRef.current);
    if (target) {
      setSelectedMemory(target);
    }
    pendingInitialMemoryIdRef.current = undefined;
  }, [dayLoading, dayRecords]);

  /**
   * 「今日」だけの安全な例外的マージ：Vault write未完了でも、既にIndexedDBへ保存済み
   * （＝ユーザー操作としては完了している）今回セッションのCapture結果を、選択日が
   * 今日の場合にだけ描画時にマージする。IndexedDBへの新規アクセスは一切発生しない
   * （sessionCapturedMemoriesは既にChatScreen.tsx側が保持しているReact stateを
   * そのまま受け取るだけ）。idで重複排除するため、Vault側読み込みが追いついた後に
   * 二重表示にはならない。
   */
  const displayedMemories = useMemo(() => {
    const base = dayRecords.memories;
    if (selectedDay !== todayKey() || sessionCapturedMemories.length === 0) {
      return base;
    }
    const seenIds = new Set(base.map((memory) => memory.id));
    const todaysSessionMemories = sessionCapturedMemories.filter(
      (memory) => memory.date.slice(0, 10) === selectedDay && !seenIds.has(memory.id)
    );
    if (todaysSessionMemories.length === 0) return base;
    return [...base, ...todaysSessionMemories].sort((a, b) => a.date.localeCompare(b.date));
  }, [dayRecords, selectedDay, sessionCapturedMemories]);

  const hasSessionRecordToday = useMemo(
    () => sessionCapturedMemories.some((memory) => memory.date.slice(0, 10) === todayKey()),
    [sessionCapturedMemories]
  );

  function dayHasRecord(day: string): boolean {
    const entry = monthIndex?.days[day];
    if (entry && (entry.conversationIds.length > 0 || entry.memoryCount > 0)) return true;
    return day === todayKey() && hasSessionRecordToday;
  }

  // Memoryの由来会話（日時・ペルソナ）を一言添えるための索引。既に読み込み済みの
  // その日のconversationsからだけ作る（追加のVault読み込みは行わない。由来会話が
  // 別の日にある場合は、この一覧に無いため表示を省略する——UIの完全再現ではなく
  // 「その日の記録を確認できる」ことを優先する今回の方針による割り切り）。
  const conversationById = new Map(dayRecords.conversations.map((c) => [c.id, c]));

  const monthGrid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  function goToMonth(delta: number) {
    const next = addMonths(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
  }

  function selectDay(day: string) {
    setSelectedDay(day);
    setSelectedMemory(null);
    setSelectedConversation(null);
    // 前の日付の表示が一瞬でも残らないよう、ここで即座にクリアする（実際の
    // requestId発行・dayPartsPendingRefのリセットは、直後に走るreset effect
    // （selectedDayの変化を検知して発火する）が行う）。
    setNormalMemories([]);
    setExtraDayRecords({ conversations: [], reflections: [] });
    setDayLoading(true);
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col gap-5 overflow-y-auto">
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

            {/*
              UI安定化：以前は「monthLoading中はこの外枠ごと出さない」→「monthLoading
              完了後にこの枠が現れ、その中でさらにdayLoadingを見る」という2段階の
              出現だったため、カレンダー直下の高さが2回変化していた。selectedDayが
              確定していれば（通常は常にtrue）この外枠（区切り線・日付ラベル）自体は
              常に出したままにし、中身だけを「読み込んでいます…」⇄実際の内容で
              切り替えることで、外枠の出現によるレイアウト変化を1回減らす（見た目・
              配色・大規模な作り直しはしない）。
            */}
            {selectedDay && (
              <div className="flex flex-col gap-3 border-t border-black/5 pt-4 dark:border-white/10">
                <p className="text-xs text-stone-400 dark:text-stone-500">{selectedDay}</p>

                {monthLoading || dayLoading ? (
                  <p className="text-sm text-stone-400 dark:text-stone-500">読み込んでいます…</p>
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
                      {selectedConversation.startedAt.slice(0, 10)}・{PERSONA_LABEL[selectedConversation.persona]}
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
                            由来：{origin.startedAt.slice(0, 10)}の{PERSONA_LABEL[origin.persona]}の会話
                          </p>
                        );
                      })()}
                  </div>
                ) : (dayRecords?.conversations.length ?? 0) === 0 && displayedMemories.length === 0 ? (
                  <p className="text-sm text-stone-400 dark:text-stone-500">この日の記録はありません。</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {(dayRecords?.conversations.length ?? 0) > 0 && (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-stone-400 dark:text-stone-500">会話</p>
                        {dayRecords?.conversations.map((conversation) => (
                          <button
                            key={conversation.id}
                            type="button"
                            onClick={() => setSelectedConversation(conversation)}
                            className="flex items-center justify-between gap-4 rounded-2xl border border-stone-300/70 px-4 py-3 text-left text-sm text-stone-700 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-300 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                          >
                            <span>{PERSONA_LABEL[conversation.persona]}</span>
                            <span className="shrink-0 text-[11px] text-stone-400 dark:text-stone-500">
                              {conversation.turns.length}件のメッセージ
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {displayedMemories.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-stone-400 dark:text-stone-500">記憶</p>
                        {displayedMemories.map((memory) => (
                          <button
                            key={memory.id}
                            type="button"
                            onClick={() => setSelectedMemory(memory)}
                            className="flex flex-col gap-1 rounded-2xl border border-stone-300/70 px-4 py-3 text-left transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                          >
                            <span className="text-sm text-stone-700 dark:text-stone-300">{memory.summary}</span>
                            <span className="flex flex-wrap items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                              {memory.types.map((type) => (
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
            )}
          </>
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
