import { AUTO_CAPTURE_QUIET_MS, AUTO_CAPTURE_TIMEOUT_MS, maySendConversationTo, type AutoCaptureSettings } from "./autoCapturePolicy";
import { isOverdueRealtimeDiary, isRealtimeDiaryComplete } from "./realtimeDiary";
import type { Conversation } from "./types";

/**
 * リアルタイム日記の自動の仕上げ（PR-C、docs/realtime-diary.md）。午前4時を過ぎて対象日が終わった日記のうち、仕上がっていないものを、
 * 利用者が設定で許可した端末でだけ、次の起動時に仕上げる（終了・Memory・日記本文。手順は手動の「日記を仕上げる」と同じもの）。
 * 送り先は選んでいるAIだけ、キーは利用者自身のそのAIのキーだけ（無ければ何も送らない。別のAIへ切り替えない）。会話の自動Capture（autoCapturePolicy.ts）とは対象を分ける。
 * ここは判断だけ（何を、どの順で試すか、結果をどう記録するか）。保存・通信は呼び出し側（ChatScreen）。
 */
export const REALTIME_DIARY_AUTO_MAX_ATTEMPTS = 3;
/** 別のタブ・端末でまだ書いている（AIが返答している）かもしれない書きかけの日記には触れない */
export const REALTIME_DIARY_AUTO_QUIET_MS = AUTO_CAPTURE_QUIET_MS;
/** Memoryと日記本文、AIへの依頼は2回まで */
export const REALTIME_DIARY_AUTO_TIMEOUT_MS = 2 * AUTO_CAPTURE_TIMEOUT_MS;

export interface RealtimeDiaryAutoSettings { enabled: boolean }
export interface RealtimeDiaryAutoAttempt { attempts: number; lastAttemptAt: string }
export interface RealtimeDiaryAutoState { diaries: Record<string, RealtimeDiaryAutoAttempt> }

export function parseRealtimeDiaryAutoSettings(raw: string | undefined): RealtimeDiaryAutoSettings {
  try { return { enabled: (raw ? JSON.parse(raw) : null)?.enabled === true }; } catch { return { enabled: false }; }
}
export function parseRealtimeDiaryAutoState(raw: string | undefined): RealtimeDiaryAutoState {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && v.diaries && typeof v.diaries === "object" ? { diaries: v.diaries } : { diaries: {} };
  } catch { return { diaries: {} }; }
}

const ms = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
export const isAutoFinishStopped = (state: RealtimeDiaryAutoState, id: string) => (state.diaries[id]?.attempts ?? 0) >= REALTIME_DIARY_AUTO_MAX_ATTEMPTS;

/** 対象日が終わった（`today`より前の）日記で、書きかけのもの、または終えたがMemoryか日記本文がまだのもの */
export function isPastUnfinishedDiary(c: Conversation, today: string): boolean {
  if (!c.realtimeDiary || c.status === "archived" || c.turns.length === 0) return false;
  if (!c.endedAt) return isOverdueRealtimeDiary(c, today) && c.status === "active";
  return c.realtimeDiary.date < today && !isRealtimeDiaryComplete(c);
}

/**
 * 今回試してよい日記。古い対象日から。`onlyId`：画面で日付を切り替えて締め切った日記（このタブで書いていたので、間を空ける必要がない）。
 */
export function selectRealtimeDiaryAutoTargets(
  conversations: Conversation[], today: string, state: RealtimeDiaryAutoState, now: number, provider: string,
  sendSettings: Pick<AutoCaptureSettings, "allowOtherProviders">, onlyId?: string,
): Conversation[] {
  return conversations
    // 書きかけの日記は、しばらく何も書かれていないものだけ。終えた日記には誰も書き足せない（古い画面からの保存も断られる）ので待たない
    .filter((c) => (onlyId ? c.id === onlyId : !!c.endedAt || now - ms(c.updatedAt) >= REALTIME_DIARY_AUTO_QUIET_MS))
    .filter((c) => isPastUnfinishedDiary(c, today))
    .filter((c) => maySendConversationTo(c, provider, sendSettings))
    .filter((c) => !isAutoFinishStopped(state, c.id))
    .sort((a, b) => (a.realtimeDiary!.date < b.realtimeDiary!.date ? -1 : a.realtimeDiary!.date > b.realtimeDiary!.date ? 1 : ms(a.updatedAt) - ms(b.updatedAt)));
}

/** AIへ送る前に書く（途中で閉じても1回と数える） */
export function beginRealtimeDiaryAutoAttempt(state: RealtimeDiaryAutoState, id: string, now: number): RealtimeDiaryAutoState {
  return { diaries: { ...state.diaries, [id]: { attempts: (state.diaries[id]?.attempts ?? 0) + 1, lastAttemptAt: new Date(now).toISOString() } } };
}
/** 仕上がったら記録を消す。仕上がらなければ回数を残す（3回で止まり、ホームから手動で仕上げられる） */
export function finishRealtimeDiaryAutoAttempt(state: RealtimeDiaryAutoState, id: string, complete: boolean): RealtimeDiaryAutoState {
  if (!complete) return state;
  const diaries = { ...state.diaries };
  delete diaries[id];
  return { diaries };
}

export type RealtimeDiaryAutoOutcome = "off" | "blocked" | "offline" | "no-key" | "nothing" | "finished" | "partial";

export interface RealtimeDiaryAutoDeps {
  loadSettings(): Promise<RealtimeDiaryAutoSettings>;
  /** 選んでいるAI以外でも話した日記を送ってよいか（会話の終了・自動Captureと同じ許可） */
  loadSendSettings(): Promise<Pick<AutoCaptureSettings, "allowOtherProviders">>;
  selectedProvider(): Promise<string>;
  /** 利用者自身のキーだけ。無ければ何も送らない */
  hasUserKey(provider: string): Promise<boolean>;
  online(): boolean;
  blocked(): boolean;
  /** 別のタブが既に動かしていればnull */
  withRunLock(fn: () => Promise<RealtimeDiaryAutoOutcome>): Promise<RealtimeDiaryAutoOutcome | null>;
  readConversations(): Promise<Conversation[]>;
  readConversation(id: string): Promise<Conversation | undefined>;
  readState(): Promise<RealtimeDiaryAutoState>;
  writeState(state: RealtimeDiaryAutoState): Promise<void>;
  /** どのタブもその日記を開いておらず、Captureも仕上げも動いていないときだけfnを動かす */
  ifDiaryFree<T>(id: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  /** false：保存先のファイルが外部で編集されている（保存されている言葉が古いかもしれない） */
  vaultFileUnchanged(conversation: Conversation): Promise<boolean>;
  /** 手動の「日記を仕上げる」と同じ手順を`provider`と利用者自身のキーだけで。仕上がったらtrue */
  finish(conversation: Conversation, provider: string, signal: AbortSignal): Promise<boolean>;
  today(): string;
  now(): number;
}

/** 1回の起動につき日記1件まで。失敗は記録して返す（投げない。古いタブ・Vaultが揃っていないときだけ投げる） */
export async function runRealtimeDiaryAutoFinish(deps: RealtimeDiaryAutoDeps, options: { onlyId?: string; shouldCancel?: () => boolean } = {}): Promise<RealtimeDiaryAutoOutcome> {
  if (!(await deps.loadSettings()).enabled) return "off";
  if (deps.blocked()) return "blocked";
  if (!deps.online()) return "offline";
  const provider = await deps.selectedProvider();
  if (!(await deps.hasUserKey(provider))) return "no-key";
  const sendSettings = await deps.loadSendSettings();
  const outcome = await deps.withRunLock(async () => {
    const candidates = selectRealtimeDiaryAutoTargets(await deps.readConversations(), deps.today(), await deps.readState(), deps.now(), provider, sendSettings, options.onlyId);
    for (const candidate of candidates) {
      const run = await deps.ifDiaryFree(candidate.id, async (): Promise<RealtimeDiaryAutoOutcome | "not-sent"> => {
        // 上の一覧はロックの前に読んだもの。保存されている今の記録で決め直す
        const before = await deps.readState();
        const stored = await deps.readConversation(candidate.id);
        if (!stored || !selectRealtimeDiaryAutoTargets([stored], deps.today(), before, deps.now(), provider, sendSettings, options.onlyId).length) return "not-sent";
        if (!(await deps.vaultFileUnchanged(stored))) return "not-sent";
        await deps.writeState(beginRealtimeDiaryAutoAttempt(before, stored.id, deps.now()));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REALTIME_DIARY_AUTO_TIMEOUT_MS);
        const poll = setInterval(() => { if (options.shouldCancel?.()) controller.abort(); }, 500);
        let complete = false;
        try {
          complete = await deps.finish(stored, provider, controller.signal);
        } catch (error) {
          const name = (error as Error | undefined)?.name;
          if (name === "StaleVaultTabError" || name === "IncompleteVaultWorldError") throw error;
        } finally {
          clearTimeout(timeout);
          clearInterval(poll);
        }
        await deps.writeState(finishRealtimeDiaryAutoAttempt(await deps.readState(), stored.id, complete));
        return complete ? "finished" : "partial";
      });
      if (run.ran && run.value !== "not-sent") return run.value;
    }
    return "nothing";
  });
  return outcome ?? "blocked";
}
