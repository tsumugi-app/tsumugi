/**
 * TEMP-TEST：PC/スマホ間で応答傾向が異なって見える件の原因切り分け用（調査専用）。
 *
 * 目的は「修正」ではなく「1リクエストごとに、Geminiへ渡る直前の材料を同じ形式で
 * 突き合わせられるようにすること」。会話ロジック・Retrievalロジック・system prompt・
 * persona promptは一切変更しない。ここは既存の関数（retrieveRelevantMemories・
 * scoreMemory・needsWebSearch・getAllMemoryObjects）を読み取り専用で呼び直して
 * ログへ整形するだけの、副作用の無い診断レイヤーである。
 *
 * 既存のdebugTimingLog.tsと同じ`?debugLog=1`ゲートを使う。このクエリパラメータが
 * 無い通常のユーザーには、この関数は何もしない（コンソール出力・追加のIndexedDB読み取り・
 * localStorageへの書き込みのいずれも発生しない）。
 *
 * スマホ実機ではConsoleを開きにくいため、console.logに加えて同じ内容をlocalStorageへも
 * 保存し、`?debugLog=1`のときだけ表示されるConversationDebugPanel（画面上のパネル、
 * コピーボタン付き）から目視・コピーできるようにする（DebugTimingPanel/debugTimingLog.tsと
 * 同じ設計）。保存する内容は、下のプライバシー方針に従いconsole.logと完全に同じもの
 * （このモジュール内で1箇所だけ組み立てている文字列をそのまま使う）。
 *
 * プライバシー方針（厳守）：
 * - APIキー・system prompt本文・persona prompt本文は一切出力しない
 * - Memory本文（MemoryObject.content）は出力しない。出すのはid・summary・keywords・
 *   スコア・取得理由（direct/divergent/linked）・linkReasonの短い文字列だけ
 * - 会話本文（turns[].content）はそのまま出力せず、件数と直近ユーザー発言の文字数だけを出す
 *
 * 注意（意図的な近似値であり、実際のサーバー側計算のミラーではない）：
 * - thinkingBudget・maxOutputTokensは、src/app/api/chat/route.tsの
 *   computeThinkingBudget()・maxOutputTokens定数と同じ値をここに複製して表示している
 *   だけであり、実際にサーバー側で使われた値をレスポンスから受け取っているわけではない
 *   （route.ts側は変更しないため、値を返送する仕組み自体を今回追加していない）。
 *   route.ts側の定数を変更した場合、この表示値は追随しないため、調査結果を見る際は
 *   その前提を踏まえること。
 * - スコアは、retrieval.tsの`scoreMemory()`（direct一致のスコアリング）を、このログの
 *   ためだけに再計算したものである。retrievedMemories自体が持つ`matchType`
 *   （"direct"/"divergent"、retrieval.ts参照）は実際の選定結果そのものなので、
 *   sourceの表示にはこちらを優先して使う。
 * - persona===analystのときだけ、retrieveCreativeMemories()の直接一致選定と同じ処理
 *   （selectConversationDirectMatches、retrieval.tsからそのままimportして再利用。
 *   ロジックの複製はしていない）をこのログのためだけに再実行し、Conversation Retrieval
 *  （Conversation品質改善 第2修正）のtopic anchor・スコア内訳（queryScore/genericPenalty/
 *   anchorBonus/conversationScore）・floor未満で除外された候補・相対的な強さが
 *   足りず落とされた候補を表示する。これは実際にRetrievedMemoriesへ含まれることは
 *   無い、調査・チューニング専用の情報。表示するkeyword（topic anchor）は既存
 *   memory.keywords語彙由来の短い単語のみで、turns本文そのもの（会話全文）は
 *   ログへ出さない。
 */
"use client";

import { getAllMemoryObjects } from "./db";
import {
  CONVERSATION_MIN_SCORE,
  CONVERSATION_RECENT_TURNS_WINDOW,
  DEFAULT_LIMIT,
  computeKeywordFrequency,
  isSameConversation,
  scoreMemory,
  selectConversationDirectMatches,
  type ConversationCandidateScore,
} from "./retrieval";
import { needsWebSearch } from "./needsWebSearch";
import {
  getActiveVaultEpoch,
  getCommittedVaultEpoch,
  getTabVaultEpoch,
  getVaultWorldJournalVersion,
  withVaultWorldRead,
} from "./vaultWorldLock";
import type { ConversationTurn, MemoryObject, Persona, RetrievedMemory } from "./types";
import type { VaultBackend } from "./vault";

/** ChatScreen.tsxのVaultStatus型を、lib→component方向の依存を避けるためここに複製した
 * 表示用の型（値は完全に同じ）。libがcomponentをimportする構造は作らない方針のため。 */
type VaultStatusForDebug =
  | "checking"
  | "connected"
  | "not-connected"
  | "unsupported"
  | "needs-permission"
  | "incomplete-switch"
  | "unsupported-journal-version";

function debugLogEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("debugLog") === "1";
  } catch {
    return false;
  }
}

const STORAGE_KEY = "tsumugi:conversationDebugLog:v1";
/** 1件あたりRetrieved Memoryの分だけ長くなりうるため、timingLogより少なめの上限にする。 */
const MAX_ENTRIES = 20;

/**
 * H4 Codexレビュー指摘High-2対応：localStorage（`tsumugi:conversationDebugLog:v1`）は
 * 全タブ・全Vaultで共有される（IndexedDBと違いepoch確認の対象外）。書き込み自体は
 * 既にwithVaultWorldReadで保護されているが、それだけでは「別Vaultへ切り替わった後、
 * 過去に書かれたログがlocalStorageに残り続け、後から（stale tab／別epochになった
 * 同じタブから）読めてしまう」問題は防げない。各エントリへ書き込み時点のepoch
 * （`tabVaultEpoch`、書き込み時点でactiveVaultEpochと一致していることが
 * withVaultWorldReadで既に確認済み）を持たせ、読み取り時にも
 * 「このタブが今stale化していないか」「このエントリのepochが今のactiveVaultEpochと
 * 一致するか」を確認する。epochを持たない旧形式エントリはepoch比較で必ず除外される
 * （安全側。既存storage schemaへのフィールド追加のみで、ストレージキー自体は変えない）。
 */
interface StoredEntry {
  ts: number;
  /** このエントリが書き込まれた時点のtabVaultEpoch（＝その瞬間のactiveVaultEpochと一致）。 */
  epoch: number;
  text: string;
}

function readEntries(): StoredEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

function appendEntry(text: string, epoch: number): void {
  try {
    const entries = readEntries();
    entries.push({ ts: Date.now(), epoch, text });
    while (entries.length > MAX_ENTRIES) entries.shift();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // パネル表示用の保存に失敗しても、console.log側は既に出力済みのため実害は無い。
  }
}

/**
 * ConversationDebugPanel（画面上のパネル）が読む。`?debugLog=1`が無い通常URLでは
 * パネル自体が描画されないため、この関数もそこからしか呼ばれない想定。
 *
 * H4 Codexレビュー指摘High-2対応：読み取り時にも必ずepochを確認する（非同期化）。
 * - このタブ自身が今staleである（tabVaultEpochがactiveVaultEpochと一致しない）場合、
 *   一切返さない（空配列）。
 * - Codexレビュー指摘（journal lifecycle）対応：さらにcommittedVaultEpochが
 *   validかつactiveVaultEpochと一致することも要求する（incomplete/missing/invalid
 *   journalの間は、たとえtabEpoch===activeEpochでも保存済みログを一切返さない）。
 * - 保存されているエントリのうち、今のactiveVaultEpochと一致するものだけ返す
 *   （別Vault・別世代で書かれたエントリ、およびepochを持たない旧形式エントリは
 *   常に除外される。この既存filteringは維持）。
 * epoch確認自体が失敗した場合も、安全側で空配列を返す。
 */
export async function getConversationDebugLog(): Promise<{ ts: number; text: string }[]> {
  if (typeof window === "undefined") return [];
  try {
    const tabEpoch = getTabVaultEpoch();
    const activeEpoch = await getActiveVaultEpoch();
    if (tabEpoch === null || tabEpoch !== activeEpoch) {
      // このタブは今stale。別Vaultのログは一切見せない。
      return [];
    }
    // Codexレビュー指摘（Medium：unexpected version core guard／debug getterも
    // version確認）対応：committed一致だけでなく、journal versionがcurrentであることも
    // 要求する。missing/unexpected versionでは（たとえtab===active===committedが
    // 偶然揃っても）保存済みログを一切返さない。
    const versionStatus = await getVaultWorldJournalVersion();
    if (versionStatus.status !== "current") {
      return [];
    }
    const committedStatus = await getCommittedVaultEpoch();
    if (committedStatus.status !== "valid" || committedStatus.epoch !== activeEpoch) {
      // journalがincomplete/missing/invalid。保存済みログも一切返さない。
      return [];
    }
    return readEntries()
      .filter((entry) => entry.epoch === activeEpoch)
      .map(({ ts, text }) => ({ ts, text }));
  } catch (error) {
    console.warn("[ConversationDebug] failed to verify epoch for debug log read, refusing to return entries", error);
    return [];
  }
}

export function clearConversationDebugLog(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}

/** route.ts の computeThinkingBudget() と同じ式をここに複製しているだけの表示用ミラー。
 * 実際にサーバーが使った値の取得ではない（上のファイル冒頭コメント参照）。 */
function mirrorThinkingBudget(latestUserMessage: string): number {
  const length = latestUserMessage.length;
  if (length < 120) return 128;
  if (length < 400) return 384;
  return 768;
}

/** route.ts の maxOutputTokens: 4096 をそのまま複製した表示用の定数。 */
const MIRROR_MAX_OUTPUT_TOKENS = 4096;

/** ざっくりとしたモバイル判定（UA文字列ベース。表示用の参考情報であり、
 * アプリの挙動分岐には使わない＝vault.tsのgetVaultBackend()等とは無関係）。 */
function roughDeviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  return isMobile ? "mobile" : "desktop";
}

export interface ConversationDebugParams {
  persona: Persona;
  turns: ConversationTurn[];
  retrievedMemories: RetrievedMemory[];
  latestUserMessage: string;
  vaultBackend: VaultBackend | null;
  vaultStatus: VaultStatusForDebug;
  /** persona===analystのとき、落とされたdirect候補を再現するために使う
   * （retrieveRelevantMemories()へ渡しているexcludeConversationIdと同じ値）。 */
  excludeConversationId?: string;
}

/**
 * 1リクエスト分の「Geminiへ渡る直前の材料」をまとめてconsoleへ出す。
 * `?debugLog=1`が無い場合は即return（追加のIndexedDB読み取りも発生しない）。
 * 失敗してもhandleSend()本体には一切影響させない（呼び出し元でvoidして使うこと）。
 */
export async function logConversationDebug(params: ConversationDebugParams): Promise<void> {
  if (!debugLogEnabled()) return;

  try {
    // H4 Codexレビュー指摘High-3対応：getAllMemoryObjects()はMemory World全体の読み取りで
    // あるため、通常のRetrieval/Capture等と同じく共有ロック＋epoch確認（withVaultWorldRead）
    // で保護する。stale tab（別タブでVaultが切り替わった後のタブ）では、Memory内容に
    // 一切触れる前にStaleVaultTabErrorで拒否され、下のcatchでログ出力自体を諦める
    // （B（別Vault）のMemory summaryがconsole/localStorageへ出ることはない）。
    await withVaultWorldRead(async () => {
      const { persona, turns, retrievedMemories, latestUserMessage, vaultBackend, vaultStatus, excludeConversationId } =
        params;

      // H4 Codexレビュー指摘High-2対応：ここ（withVaultWorldReadのfn内）に到達した時点で
      // tabVaultEpochは必ずactiveVaultEpochと一致している（withVaultWorldRead自身が
      // 直前に確認済みのため）。このエントリが「どのVault世代で書かれたものか」を
      // 記録するため、書き込み時点のepochを取得しておく（読み取り側getConversationDebugLog
      // が、今のactiveVaultEpochと一致するエントリだけを返すために使う）。
      const writeEpoch = getTabVaultEpoch();
      if (writeEpoch === null) {
        // 理論上ここには来ないはず（withVaultWorldReadがnullなら既に拒否している）だが、
        // 万一の場合は安全側でログ出力自体を諦める。
        return;
      }

      // memoryCount・スコア再計算のためだけの読み取り専用アクセス（既存のgetAllMemoryObjects()を
      // 呼び直すだけで、retrieveRelevantMemories()自体の呼び出し回数・挙動は変えない）。
      const allMemories = await getAllMemoryObjects();
      const byId = new Map<string, MemoryObject>(allMemories.map((memory) => [memory.id, memory]));
      const trimmed = latestUserMessage.trim();

      const retrieved = retrievedMemories.map((memory) => {
        const full = byId.get(memory.id);
        const score = full ? Number(scoreMemory(full, trimmed).toFixed(2)) : null;
        // sourceは、実際の選定結果であるmatchType（"direct"/"divergent"）を優先する。
        // matchTypeが無い（companion/coach、またはpromptedMemoryId経由）場合のみ、
        // 従来通りlinkReasonの有無で"linked"/"direct"を判定する。
        const source = memory.matchType ?? (memory.linkReason ? "linked" : "direct");
        return {
          id: memory.id,
          score,
          summary: memory.summary,
          source,
          isOriginMemory: memory.isOriginMemory === true,
          linkReason: memory.linkReason ?? null,
        };
      });

      const directCount = retrieved.filter((r) => r.source === "direct").length;
      const divergentCount = retrieved.filter((r) => r.source === "divergent").length;
      const linkedCount = retrieved.filter((r) => r.source === "linked").length;

      // persona===analystのときだけ、retrieveCreativeMemories()と全く同じ関数
      // （selectConversationDirectMatches）を読み取り専用で再実行し、Conversation Retrieval
      // のtopic anchor・スコア内訳・floor/相対フィルタでの除外理由を再現する。
      // ロジックの複製ではなく、同じ関数の再呼び出し（実際の選定結果とログの内訳が
      // 常に一致することを保証するため）。
      let conversationRetrievalLines: string[] = [];
      if (persona === "analyst") {
        const pool = allMemories.filter((memory) => !isSameConversation(memory.conversationId, excludeConversationId));
        const keywordFrequency = computeKeywordFrequency(allMemories);
        // 実際の送信呼び出し（ChatScreen.tsx）と同じ抽出方法で揃える（role==="user"のcontentをtrim）。
        // turns本文はkeyword存在判定だけに使い、ログへ生のturn本文を出すことはしない。
        const recentUserTurnsTexts = turns
          .filter((turn) => turn.role === "user")
          .map((turn) => turn.content.trim())
          .filter(Boolean);

        const selection = selectConversationDirectMatches(pool, trimmed, recentUserTurnsTexts, keywordFrequency, DEFAULT_LIMIT);

        const fmt = (entry: ConversationCandidateScore) =>
          `id=${entry.memory.id} conversationScore=${entry.conversationScore.toFixed(2)} ` +
          `(queryScore=${entry.queryScore.toFixed(2)} genericPenalty=-${entry.genericPenalty.toFixed(2)} anchorBonus=+${entry.anchorBonus.toFixed(2)}) ` +
          `summary="${entry.memory.summary}"`;

        conversationRetrievalLines = [
          `conversationTopicAnchors(直近user turns${recentUserTurnsTexts.length}件のうち、window上限${CONVERSATION_RECENT_TURNS_WINDOW}件(暫定値)から抽出): ${
            selection.anchors.length === 0
              ? "(なし)"
              : selection.anchors
                  .map((a) => `${a.keyword}(distinctiveness=${a.distinctiveness.toFixed(2)}, turnsContaining=${a.turnsContaining})`)
                  .join(", ")
          }`,
          `conversationRetrieval: floor=${CONVERSATION_MIN_SCORE}(暫定値) considered=${selection.consideredCount} kept=${selection.kept.length} droppedByFloor=${selection.droppedByFloor.length} droppedByRelativeStrength=${selection.droppedByRelativeStrength.length}`,
          ...selection.kept.map((entry) => `  kept: ${fmt(entry)}`),
          ...selection.droppedByFloor.map((entry) => `  droppedByFloor: ${fmt(entry)}`),
          ...selection.droppedByRelativeStrength.map((entry) => `  droppedByRelativeStrength: ${fmt(entry)}`),
        ];
      }

      const lines = [
        "[ConversationDebug]",
        `device/environment: ${roughDeviceLabel()} (userAgent="${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}")`,
        `vault: backend=${vaultBackend ?? "none"} status=${vaultStatus}`,
        `persona: ${persona}`,
        `latestUserMessageLength: ${trimmed.length}`,
        `historyCount(turns): ${turns.length}`,
        `memoryCount(total, this device's IndexedDB): ${allMemories.length}`,
        `retrievedCount: ${retrievedMemories.length} (direct=${directCount}, divergent=${divergentCount}, linked=${linkedCount})`,
        "retrieved:",
        ...retrieved.map(
          (r, i) =>
            `  [${i}] id=${r.id} score=${r.score ?? "n/a"} source=${r.source}${r.isOriginMemory ? " origin=true" : ""} summary="${r.summary}"${r.linkReason ? ` linkReason="${r.linkReason}"` : ""}`
        ),
        ...conversationRetrievalLines,
        `finalContextSummary: retrievedMemoriesSectionPresent=${retrievedMemories.length > 0} charLenOfSummaries=${retrieved.reduce((sum, r) => sum + r.summary.length, 0)}`,
        `generationConfig(mirrored from route.ts constants, not the actual server-reported value): thinkingBudget=${mirrorThinkingBudget(trimmed)} maxOutputTokens=${MIRROR_MAX_OUTPUT_TOKENS} enableWebSearch=${needsWebSearch(trimmed)}`,
      ];

      const text = lines.join("\n");
      console.log(text);
      appendEntry(text, writeEpoch);
    });
  } catch (error) {
    // 調査用ログの失敗は本体の会話送信処理に一切影響させない（StaleVaultTabErrorの場合も
    // ここで一律に捕捉され、Memory内容には一切触れないままログ出力自体を諦める）。
    console.warn("[ConversationDebug] failed to build debug log", error);
  }
}
