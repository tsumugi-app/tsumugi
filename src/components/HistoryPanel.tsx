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
import type { HistoryDayIndex, HistoryDayIndexV2, HistoryMonthIndex } from "@/lib/vault";
import type { Conversation, ConversationTurn, MemoryObject, MemoryType, Persona } from "@/lib/types";
import { getJstTodayDateString, getJstYearMonth } from "@/lib/jstDate";
import { jstDateOf, jstDateOfUlid, monthKeyOfDateKey, previousDateKey } from "@/lib/dateModel";

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
 * 画面上の「今日」はAsia/Tokyo（JST）基準で判定する（`@/lib/jstDate`、日本時間0:00〜8:59に
 * UTC日付が前日にずれる不具合の修正）。
 *
 * JST日付モデル Phase 1（Logical Date / Storage Bucket分離）：このコンポーネント内で
 * `selectedDay`・カレンダーのマス目・`todayKey()`が表す日付は、すべて**Logical
 * Date**（JST）である。一方、Vault内のMarkdown命名規則・History Indexのkey
 * （`fileNameFor`/`dayFileNameFor`、`src/lib/vault.ts`）は、既存Vaultとの後方互換の
 * ため引き続きUTC基準の日付文字列（**Storage Bucket**）のまま変更していない。
 * そのため、Logical Date 1日分のレコードは、Storage Bucket上ではその日自身と前日
 * （`@/lib/dateModel`の`previousDateKey`）の2つのbucketにまたがって存在しうる。
 * 下記`resolveBucketDayRecords`・`loadLogicalDay`が、この2bucket分をまとめて読み、
 * 各レコードの実時刻からLogical Dateを計算して選び直す（詳細は各関数のコメント参照）。
 */
function todayKey(): string {
  return getJstTodayDateString();
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
 *
 * `bucketDay`（JST日付モデル Phase 1追加）：このrowが実際に存在するStorage Bucket
 * （UTC基準の日付文字列。`selectedDay`＝Logical Dateとは別物）。詳細読み込み時に
 * `readConversationById(handle, id, bucketDay)`へそのまま渡す——Vault側の
 * `fileNameFor`/Registryのfallback pathはStorage Bucket基準のため、Logical Date
 * を渡すと誤ったファイル名を組み立ててしまう。
 */
interface ConversationRow {
  id: string;
  modeLabel: string;
  turnCount: number;
  bucketDay: string;
  full?: Conversation;
}

/**
 * 通常Memory／Reflection共通の一覧行。`origin`で詳細表示時にどちらの本体read経路
 * （`readMemoriesForDay`+find／`readReflectionById`）を使うかを判定する
 * （`types`だけでは判別できない——通常Memoryも`types`に"insight"を持ちうるため）。
 *
 * `bucketDay`：`ConversationRow`と同じ理由（Storage Bucket、詳細read時のpath解決に使う）。
 * `date`（JST日付モデル Phase 1追加、通常Memoryのみ）：`MemoryObject.date`
 * （Conversation Date）。History Index v2の`HistoryMemorySummary.date`、または
 * v1 fallbackで読んだ本体の`.date`をそのまま持つ。Reflectionは設定しない
 * （ReflectionのLogical Dateは`createdAt`＝生成時刻そのもの、という既存の意味を
 * 変えないため）。`logicalDateOfMemoryRow`参照。
 */
interface MemoryRow {
  id: string;
  types: MemoryType[];
  preview: string;
  createdAt: string;
  date?: string;
  origin: "normal" | "reflection";
  bucketDay: string;
  full?: MemoryObject;
}

/**
 * ConversationのLogical Date（JST）。本体を読み終えている（`full`）場合は
 * `startedAt`から正確に求める。未読（v2の一覧行）の場合は、追加のMarkdown readを
 * 行わず、`id`（ULID）の生成時刻から近似する（`conversation.id`は`conversation.startedAt`
 * とほぼ同時に採番されるため、実務上ずれない。`src/lib/dateModel.ts`の
 * `jstDateOfUlid`コメント参照）。いずれも失敗した場合は`bucketDay`（Storage Bucket）
 * へfail-softにfallbackする（表示上「1日ずれる可能性はあるが、記録自体は必ずどこかに
 * 表示される」ことを優先する）。
 */
function logicalDateOfConversationRow(row: ConversationRow): string {
  const fromFull = row.full ? jstDateOf(row.full.startedAt) : null;
  return fromFull ?? jstDateOfUlid(row.id) ?? row.bucketDay;
}

/**
 * 通常Memory/ReflectionのLogical Date（JST）。
 * - 通常Memory：`Memory.date`（＝Conversation Date、由来Conversationの開始時刻）を
 *   基準にする（`row.date`、または本体を読み終えていれば`row.full.date`）。
 * - Reflection：`createdAt`（生成時刻）を基準にする（既存の意味のまま、変更しない）。
 * いずれもparse失敗時は`bucketDay`へfail-softにfallbackする。
 */
function logicalDateOfMemoryRow(row: MemoryRow): string {
  if (row.origin === "reflection") {
    return jstDateOf(row.createdAt) ?? row.bucketDay;
  }
  const basis = row.full?.date ?? row.date ?? row.createdAt;
  return jstDateOf(basis) ?? row.bucketDay;
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
  const [viewYear, setViewYear] = useState(() => getJstYearMonth().year);
  const [viewMonth, setViewMonth] = useState(() => getJstYearMonth().month);
  const [selectedDay, setSelectedDay] = useState<string | null>(todayKey());
  /**
   * visibilitychange時に「JSTの今日が変わったか」を判定するための、直近に把握していた
   * JST今日の日付。ユーザーが過去の月・日を意図的に閲覧している場合は、日付が変わっても
   * 表示を今日へ強制的に戻さないための基準値として使う（後述のuseEffect参照）。
   */
  const lastKnownTodayRef = useRef(todayKey());
  const [selectedMemory, setSelectedMemory] = useState<MemoryObject | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const [monthIndex, setMonthIndex] = useState<HistoryMonthIndex | null>(null);
  /**
   * JST日付モデル Phase 1追加：表示中の月（`viewYear`/`viewMonth`、Logical Date基準）の
   * 1つ前の月のStorage Bucket月Index。月初日（Logical Dateの1日）のLogical Dateを
   * 解決するには、前日にあたるStorage Bucket（前月最終日になりうる）も見る必要があるため
   * （`previousDateKey`/`resolveBucketDayRecords`参照）。`monthIndex`と同じ読み込み
   * effectでペアとして取得・破棄する。
   */
  const [prevMonthIndex, setPrevMonthIndex] = useState<HistoryMonthIndex | null>(null);
  const [monthLoading, setMonthLoading] = useState(true);
  const [conversationRows, setConversationRows] = useState<ConversationRow[]>([]);
  const [memoryRows, setMemoryRows] = useState<MemoryRow[]>([]);
  const [dayLoading, setDayLoading] = useState(false);
  /** 一覧行タップ時のオンデマンド詳細読み込み中だけtrue（v2の日、または本体未読の行）。 */
  const [detailLoading, setDetailLoading] = useState(false);
  /**
   * 実機不具合対応（原則B）：一覧行をタップしたが本体を読めなかった場合にtrue。
   * History上には行として残っている（存在した記録）にもかかわらず読めない場合、
   * 無言で何も起きなかったように見せず「この記録は現在開けません。」とだけ表示する。
   *
   * Codex監査対応（M1）：read failureは、Registry statusがok以外・ファイル不存在・
   * 権限/I-O失敗・parse失敗・day-file内に対象recordが存在しない、等の複数の原因が
   * null/空の戻り値へ集約されており、History側では実際の原因を判別できない。
   * そのため原因を断定する文言や、解決手段の無い「設定を開く」導線は出さない
   * （以前は「Vaultを再同期してください」と案内していたが、Settingsには対応する
   * 復旧操作が無く誤誘導だったため削除した）。
   */
  const [detailUnavailable, setDetailUnavailable] = useState(false);

  /**
   * 実機不具合対応（stale detail修正）：`refreshToken`（Vault再同期完了時等に
   * ChatScreen側でインクリメントされる）が変わった時点で、直前に開いていた
   * detail画面のstateをリセットする。理由：`refreshToken`変化を検知する
   * 既存effect（下記、月/日一覧の再取得用）は`conversationRows`/`memoryRows`等
   * 一覧側のstateしか更新せず、`selectedConversation`/`selectedMemory`/
   * `detailUnavailable`（1行タップ時にだけ設定される、detail画面固有のstate）は
   * 一切触れない。そのため、「この記録は現在開けません。」を表示したまま裏で
   * Vault側の状態が解決してHistoryへ戻ると、この画面には古いエラー表示が残り
   * 続けていた。自動的な再オープンは行わない（「戻る」を押して行を選び直せば
   * 最新状態で読み直される）——ここでは古い状態を残さないことだけを保証する。
   */
  useEffect(() => {
    setDetailUnavailable(false);
    setSelectedConversation(null);
    setSelectedMemory(null);
  }, [refreshToken]);

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
      setPrevMonthIndex(null);
      setMonthLoading(false);
      return;
    }

    const vaultChanged = previousVaultHandleRef.current !== vaultHandle;
    previousVaultHandleRef.current = vaultHandle;

    let targetYear = viewYear;
    let targetMonth = viewMonth;

    if (vaultChanged) {
      vaultGenerationRef.current += 1;
      // JST日付モデル Phase 1修正：以前は`new Date().getFullYear()/getMonth()`という
      // 端末のローカルタイムゾーン基準の「今月」を使っていた（デバイスが海外時間帯に
      // 設定されている場合、JSTの「今月」とずれうる）。Logical Dateは常にJST基準の
      // ため、ここも`getJstYearMonth()`に揃える。
      const jstNow = getJstYearMonth();
      targetYear = jstNow.year;
      targetMonth = jstNow.month;
      setSelectedDay(todayKey());
      setSelectedMemory(null);
      setSelectedConversation(null);
      setDetailUnavailable(false);
      setMonthIndex(null);
      setPrevMonthIndex(null);
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
    // JST日付モデル Phase 1：前月のStorage Bucket月Indexも合わせて読む（月初日の
    // Logical Dateが前月最終日のStorage Bucketに属しうるため。`prevMonthIndex`の
    // コメント参照）。取得失敗時はその月に記録が無いのと同じ扱い（月末境界のみ影響、
    // 詳細な安全側の扱いは`monthLoading`ガードで既存の日詳細effectに委ねる）。
    const prevYearMonth = addMonths(targetYear, targetMonth, -1);
    setMonthLoading(true);
    Promise.all([
      readHistoryMonthIndex(handle, monthKeyOf(targetYear, targetMonth)),
      readHistoryMonthIndex(handle, monthKeyOf(prevYearMonth.year, prevYearMonth.month)),
    ])
      .then(([index, prevIndex]) => {
        if (monthRequestRef.current !== requestId) return; // 月移動／Vault切替で既に無効化された要求
        setMonthIndex(index);
        setPrevMonthIndex(prevIndex);
        setMonthLoading(false);
      })
      .catch((error) => {
        if (monthRequestRef.current !== requestId) return;
        console.error("Failed to load history month index", error);
        setMonthIndex(null);
        setPrevMonthIndex(null);
        setMonthLoading(false);
      });
    // initialMemoryIdは「vaultHandleが変わった時にリセットする」という目的だけで
    // 参照しており、依存に含めるとinitialMemoryIdの変化のたびに月・日表示まで
    // リセットしてしまうため、意図的に依存配列から外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultHandle, viewYear, viewMonth, refreshToken]);

  /**
   * PWAがバックグラウンドから復帰した際（`visibilitychange`でhidden→visibleになった時）に、
   * JST基準の「今日」が変わっていないかを確認する（`useState`の初期値はmount時に固定され、
   * 自動では再計算されないため）。`setInterval`によるポーリングは行わない。
   *
   * 日付が変わっていた場合でも、無条件に「今日」へ表示を戻すことはしない。ユーザーが
   * 過去の月・日を意図的に閲覧中の場合（例：9/10を見ている最中に日付が9/17へ進んだ場合）は
   * 表示を変更しない。「今日」を見ていた（＝表示中のviewYear/viewMonth/selectedDayが、
   * 直前まで把握していた今日の日付と一致していた）場合にのみ、新しい今日へ表示を進める
   * （例：9/16を「今日」として見ていた状態で日付が9/17に変わった場合は9/17へ進める）。
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;

      const previousToday = lastKnownTodayRef.current;
      const newToday = todayKey();
      if (newToday === previousToday) return;

      const [previousYear, previousMonth] = previousToday.split("-").map(Number);
      const wasFollowingToday = viewYear === previousYear && viewMonth === previousMonth && selectedDay === previousToday;

      lastKnownTodayRef.current = newToday;

      if (wasFollowingToday) {
        const { year: newYear, month: newMonth } = getJstYearMonth();
        setViewYear(newYear);
        setViewMonth(newMonth);
        setSelectedDay(newToday);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [viewYear, viewMonth, selectedDay]);

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
   * 日付詳細読み込み・その2（解決、JST日付モデル Phase 1で全面改訂）：`selectedDay`は
   * Logical Date（JST）。この1日分の記録は、Storage Bucket上では`selectedDay`自身と
   * その前日（`previousDateKey`、JST 0:00〜8:59台の記録が置かれるbucket）の2つに
   * またがって存在しうるため、両方のbucketを独立して解決してから、各レコードの
   * 実時刻から計算したLogical Dateで`selectedDay`に一致するものだけへ絞り込み、
   * マージする。
   *
   * bucket単位の解決自体（v2ならVault本体read 0回、v1ならid経由でMarkdown本体を
   *読むfallback＋lazy upgrade）は、既存のロジックを`resolveBucketDayRecords`
   * （bucket 1つ分）へそのまま移しただけで、read経路・lazy upgradeの発火条件は
   * 変更していない。upgradeHistoryDayToV2は引き続きbucket day単位（Storage Bucket
   * のkeyそのもの）で書き込む——Logical Dateでbucketを書き換えることは無い
   * （Storage Bucketは後方互換のため変更しない、という前提を保つ）。
   *
   * monthLoading完了を待つ（月Index・前月Indexが無いとv1/v2の判定自体ができないため）。
   * `skipDayFetchRef`がtrue（キャッシュヒット、またはvaultHandle/selectedDayが無い）
   * の場合は何もしない。
   */
  useEffect(() => {
    if (!vaultHandle || !selectedDay || monthLoading || skipDayFetchRef.current) return;
    const requestId = dayRequestRef.current;
    const handle = vaultHandle;
    const logicalDay = selectedDay;
    const monthIndexAtStart = monthIndex;
    const prevMonthIndexAtStart = prevMonthIndex;

    /** `bucketDay`（Storage Bucket）が属する月Indexのスナップショットを選ぶ。
     *  `HistoryMonthIndex.month`フィールド（そのIndex自身が表す月）で判定するため、
     *  `viewYear`/`viewMonth`（表示中の月、Logical Date基準）とは独立に正しく解決できる。 */
    function snapshotFor(bucketDay: string): { snapshot: HistoryMonthIndex | null; isCurrent: boolean } {
      const bucketMonth = monthKeyOfDateKey(bucketDay);
      if (monthIndexAtStart && monthIndexAtStart.month === bucketMonth) {
        return { snapshot: monthIndexAtStart, isCurrent: true };
      }
      if (prevMonthIndexAtStart && prevMonthIndexAtStart.month === bucketMonth) {
        return { snapshot: prevMonthIndexAtStart, isCurrent: false };
      }
      return { snapshot: null, isCurrent: true };
    }

    /**
     * Storage Bucket 1日分を解決する（既存のv2直読み／v1 fallback＋lazy upgradeの
     * ロジックそのもの、bucket単位に切り出しただけ）。返す行はLogical Dateによる
     * 絞り込みをまだ行っていない未フィルタの状態（呼び出し側がまとめて絞り込む）。
     */
    async function resolveBucketDayRecords(
      bucketDay: string
    ): Promise<{ conversations: ConversationRow[]; memories: MemoryRow[] }> {
      const { snapshot, isCurrent } = snapshotFor(bucketDay);
      const dayEntry: HistoryDayIndex | undefined = snapshot?.days[bucketDay];

      if (dayEntry && isHistoryDayIndexV2(dayEntry)) {
        // v2：Vault本体read 0回で一覧を構築する。
        const conversations: ConversationRow[] = dayEntry.conversations.map((c) => ({
          id: c.id,
          modeLabel: c.mode === "diary" ? "日記" : "会話",
          turnCount: c.turnCount,
          bucketDay,
        }));
        const memories: MemoryRow[] = [
          ...dayEntry.normalMemories.map((m) => ({
            id: m.id,
            types: m.types,
            preview: m.preview,
            createdAt: m.createdAt,
            date: m.date,
            origin: "normal" as const,
            bucketDay,
          })),
          ...dayEntry.reflections.map((m) => ({
            id: m.id,
            types: m.types,
            preview: m.preview,
            createdAt: m.createdAt,
            origin: "reflection" as const,
            bucketDay,
          })),
        ];
        return { conversations, memories };
      }

      // v1（またはエントリ未登録）：既存のfallback経路で本体を直接読む。
      const reflectionIds = dayEntry?.reflectionIds ?? [];
      const conversationIds = dayEntry?.conversationIds ?? [];

      const [memoriesDir, conversationsDir] = await Promise.all([
        reflectionIds.length > 0
          ? handle.getDirectoryHandle("Memories", { create: false }).catch(() => undefined)
          : Promise.resolve(undefined),
        conversationIds.length > 0
          ? handle.getDirectoryHandle("Conversations", { create: false }).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const [normalMemoriesFull, reflectionResults, conversationResults] = await Promise.all([
        readMemoriesForDay(handle, bucketDay),
        Promise.all(reflectionIds.map((id) => readReflectionById(handle, id, bucketDay, memoriesDir))),
        Promise.all(conversationIds.map((id) => readConversationById(handle, id, bucketDay, conversationsDir))),
      ]);

      const reflectionsFull = reflectionResults.filter((memory): memory is MemoryObject => memory !== null);
      const conversationsFull = conversationResults.filter(
        (conversation): conversation is Conversation => conversation !== null
      );

      const conversations: ConversationRow[] = conversationsFull.map((c) => ({
        id: c.id,
        modeLabel: personaModeLabel(c.persona),
        turnCount: c.turns.length,
        full: c,
        bucketDay,
      }));
      const memories: MemoryRow[] = [
        ...normalMemoriesFull.map((m) => ({
          id: m.id,
          types: m.types,
          preview: m.summary,
          createdAt: m.createdAt,
          date: m.date,
          origin: "normal" as const,
          full: m,
          bucketDay,
        })),
        ...reflectionsFull.map((m) => ({
          id: m.id,
          types: m.types,
          preview: m.summary,
          createdAt: m.createdAt,
          origin: "reflection" as const,
          full: m,
          bucketDay,
        })),
      ];

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
            date: m.date,
          })),
          reflections: reflectionsFull.map((m) => ({
            id: m.id,
            types: m.types,
            preview: truncateHistoryPreview(m.summary),
            createdAt: m.createdAt,
          })),
        };
        void upgradeHistoryDayToV2(handle, bucketDay, v2Entry)
          .then(() => {
            // 対応するスナップショット自体が（Vault切替・月移動・別のupgrade等で）
            // 既に別のものへ変わっていれば何もしない（stale patchを防ぐ。参照の一致で判定する）。
            const setter = isCurrent ? setMonthIndex : setPrevMonthIndex;
            setter((current) => {
              if (current !== snapshot || !current) return current;
              return { ...current, days: { ...current.days, [bucketDay]: v2Entry } };
            });
          })
          .catch((error) => {
            // 失敗してもHistory表示自体（既にfallbackで確定している表示）は
            // 失敗させない。次にこの日を開いた時、再度fallback→upgradeを試みる。
            console.error("[Tsumugi] failed to lazily upgrade history day index (display unaffected):", error);
          });
      }

      return { conversations, memories };
    }

    (async () => {
      try {
        const bucketDays = [logicalDay, previousDateKey(logicalDay)];
        const perBucket = await Promise.all(bucketDays.map((bucketDay) => resolveBucketDayRecords(bucketDay)));
        if (dayRequestRef.current !== requestId) return; // 日付切替／Vault切替で既に無効化された要求

        const conversationRowsNext = perBucket
          .flatMap((r) => r.conversations)
          .filter((row) => logicalDateOfConversationRow(row) === logicalDay);
        const memoryRowsNext = perBucket
          .flatMap((r) => r.memories)
          .filter((row) => logicalDateOfMemoryRow(row) === logicalDay)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        setConversationRows(conversationRowsNext);
        setMemoryRows(memoryRowsNext);
        dayCacheRef.current.set(logicalDay, { conversationRows: conversationRowsNext, memoryRows: memoryRowsNext });
        setDayLoading(false);
      } catch (error) {
        if (dayRequestRef.current !== requestId) return;
        console.error("Failed to load day records", error);
        setConversationRows([]);
        setMemoryRows([]);
        setDayLoading(false);
      }
    })();
  }, [vaultHandle, selectedDay, monthIndex, prevMonthIndex, monthLoading, refreshToken]);

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
      // JST日付モデル Phase 1：`selectedDay`（Logical Date）ではなく`row.bucketDay`
      // （Storage Bucket、この行が実際に置かれているVaultファイルの日付キー）を渡す。
      const conversation = await readConversationById(vaultHandle, row.id, row.bucketDay);
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
      // JST日付モデル Phase 1：ここも`row.bucketDay`（Storage Bucket）を使う
      // （理由は`openConversationRow`と同じ）。
      if (row.origin === "reflection") {
        const memory = await readReflectionById(vaultHandle, row.id, row.bucketDay);
        if (detailRequestRef.current !== requestId) return;
        if (memory) setSelectedMemory(memory);
        else setDetailUnavailable(true);
      } else {
        // 通常Memoryは1日1Markdown（複数件統合）のため、1件だけを取り出すファイル形式が
        // 無い。そのbucket dayのday-fileを1回読み、対象idをfindする（既存の
        // readMemoriesForDayを再利用するだけで、新しいvault.ts関数は追加しない）。
        const dayMemories = await readMemoriesForDay(vaultHandle, row.bucketDay);
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
      // JST日付モデル Phase 1修正：`memory.date`のLogical Date（JST）で判定する
      // （以前はUTCベースの`slice(0, 10)`で、JST 0:00〜8:59台に保存された今回
      // セッションのMemoryが「今日」の一覧から漏れることがあった）。
      .filter((memory) => jstDateOf(memory.date) === selectedDay && !seenIds.has(memory.id))
      .map((memory) => ({
        id: memory.id,
        types: memory.types,
        preview: memory.summary,
        createdAt: memory.createdAt,
        date: memory.date,
        origin: "normal" as const,
        // sessionCapturedMemoriesはIndexedDB由来（まだVault writeが確定していない
        // 可能性がある）のため、bucketDayはVault書き込み側と同じ規則
        // （`memoryObject.date.slice(0, 10)`、Storage Bucket＝UTC）で計算する
        // だけで、実際にそのファイルへ書き込み済みとは限らない（detail readには
        // 使わない——このrowは常に`full`を持つため、openMemoryRowが`row.bucketDay`を
        // 使う経路そのものに入らない）。
        bucketDay: memory.date.slice(0, 10),
        full: memory,
      }));
    if (todaysSessionRows.length === 0) return memoryRows;
    return [...memoryRows, ...todaysSessionRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [memoryRows, selectedDay, sessionCapturedMemories]);

  const hasSessionRecordToday = useMemo(
    () => sessionCapturedMemories.some((memory) => jstDateOf(memory.date) === todayKey()),
    [sessionCapturedMemories]
  );

  /**
   * カレンダーのマス目1日分（Logical Date）に記録があるかどうか（丸印の表示用）。
   * JST日付モデル Phase 1：Logical Date `day`自身のStorage Bucketに加え、前日の
   * Storage Bucket（JST 0:00〜8:59台の記録の置き場所）も見る。
   *
   * 精度：Conversation・Reflection・v2の通常Memoryは、実時刻（ULID生成時刻／
   * `date`／`createdAt`）から正確にLogical Dateを判定する。v1（まだ一度もその日を
   * 開いていない既存Vaultの日）の通常Memoryは、個々のidを持たない`normalMemoryCount`
   * （件数のみ）でしか把握できないため、Storage Bucket日＝Logical Dateとして
   * 近似する（その日を一度開けばv2へlazy upgradeされ、以降は正確になる。既知の
   * Phase 1の制約——最終報告のリスク欄参照）。
   */
  function dayHasRecord(day: string): boolean {
    const buckets = [day, previousDateKey(day)];
    for (const bucketDay of buckets) {
      const bucketMonth = monthKeyOfDateKey(bucketDay);
      const entry =
        monthIndex && monthIndex.month === bucketMonth
          ? monthIndex.days[bucketDay]
          : prevMonthIndex && prevMonthIndex.month === bucketMonth
            ? prevMonthIndex.days[bucketDay]
            : undefined;
      if (!entry) continue;
      if (isHistoryDayIndexV2(entry)) {
        if (entry.conversations.some((c) => (jstDateOfUlid(c.id) ?? bucketDay) === day)) return true;
        if (entry.normalMemories.some((m) => (jstDateOf(m.date ?? m.createdAt) ?? bucketDay) === day)) return true;
        if (entry.reflections.some((r) => (jstDateOf(r.createdAt) ?? bucketDay) === day)) return true;
      } else {
        if (entry.conversationIds.some((id) => (jstDateOfUlid(id) ?? bucketDay) === day)) return true;
        if (entry.reflectionIds.some((id) => (jstDateOfUlid(id) ?? bucketDay) === day)) return true;
        if (entry.normalMemoryCount > 0 && bucketDay === day) return true; // 近似（上記コメント参照）
      }
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
                    <p>この記録は現在開けません。</p>
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
                    {jstDateOf(selectedConversation.startedAt) ?? selectedConversation.startedAt.slice(0, 10)}・
                    {personaModeLabel(selectedConversation.persona)}
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
                    <span>{jstDateOf(selectedMemory.date) ?? selectedMemory.date.slice(0, 10)}</span>
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
                          由来：{jstDateOf(origin.startedAt) ?? origin.startedAt.slice(0, 10)}の
                          {personaModeLabel(origin.persona)}の会話
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
