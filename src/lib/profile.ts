/**
 * Personal Profile v1（Personal Modelの最初の層）。
 *
 * 【構造】
 * - ソース層（保存）：Captureが、ユーザー自身の明示的な発言から見つけた候補を`ProfileClaim`として
 *   `MemoryObject.profileClaims`に付ける（追加のみ）。専用のIndexedDB store・Vault record・folderは作らない。
 * - ビュー層（計算のみ）：全Memoryのclaimから、`ProfileFact`（現在有効か・過去か・予定か・置き換えられたか）を
 *   決定的に計算する。保存しない。
 * - Context Assembly：今回の会話に渡す少量のProfile（core / relevant）を選ぶ。
 *
 * 【原則】
 * - LLMが出すのは候補だけ。id・slot・statedAt・sourceConversationId・recordedAt・validFrom等は、Tsumugi側が決定的に付与する。
 * - 明示的なユーザー発言だけを根拠にする（quoteはユーザーturnに逐語で含まれること）。AIの推測（性格・価値観・感情）は保存しない。
 * - 機微情報・詳細住所は保存しない。安全に判定できないclaimも保存しない（fail-closed）。denyリストに一致しなかったことを、
 *   安全の根拠にはしない（category自体を狭く保ち、各categoryで肯定的な手がかりを要求する）。
 * - 現在値（current）の更新は、記録日の新しさだけでは決めない。tense・change・validFrom・statedAtから決定的に決め、
 *   曖昧なら既存のcurrentを消さない（contested/pendingで保持する）。
 * - Profileは自然な前提として使う。今回のユーザー発言と矛盾したら、今回の発言を優先する。
 *
 * このモジュールはサーバー（/api/capture・/api/chat）とクライアントの両方から使う純粋関数だけを持つ。
 */
import {
  isValidEventTimePrecision,
  isValidEventTimeSource,
  isValidEventTimeValue,
  resolveEventTimeSourceDate,
} from "./eventTimeResolver";
import {
  PROFILE_CATEGORIES_V1,
  type ConversationTurn,
  type EventTimePrecision,
  type HouseholdRelation,
  type MemoryObject,
  type ProfileCategory,
  type ProfileChange,
  type ProfileClaim,
  type ProfileTense,
} from "./types";

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

export const PROFILE_LIMITS = {
  quoteMin: 4,
  quoteMax: 80,
  statementMin: 2,
  statementMax: 60,
  valueMax: 30,
  keyMax: 30,
  /** 1つのMemory候補（Capture出力の1項目）あたり */
  perMemoryItem: 5,
  /** 1回のCapture全体 */
  perCapture: 8,
  /** 1つのMemoryに保存する上限（超えたら新しい重複から捨てる。既存claimは削除しない） */
  perMemoryStored: 12,
  /** 同じclaimKeyの保存上限（別Conversationの根拠として残す） */
  perClaimKeyStored: 3,
} as const;

export const PROFILE_CONTEXT_LIMITS = {
  coreMaxItems: 2,
  coreMaxChars: 80,
  relevantMaxItems: 4,
  relevantMaxChars: 200,
  totalMaxItems: 6,
  totalMaxChars: 300,
  /** 日付の無い予定を、注入から外すまでの日数 */
  plannedStaleDays: 90,
} as const;

const TENSES: readonly ProfileTense[] = ["current", "former", "planned"];
const CHANGES: readonly ProfileChange[] = ["none", "began", "ended"];
const HOUSEHOLD_RELATIONS: readonly HouseholdRelation[] = ["partner", "child", "parent", "sibling", "pet", "other"];

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

/** 引用の照合用（NFKC・空白の正規化のみ）。 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const PUNCT = /[\s、。，．・「」『』（）()［］\[\]{}<>,.!?！？:：;；'"“”‘’~〜\-_/\\|@#$%^&*+=`]/g;

/** slot・重複判定用のキー（NFKC・小文字化・空白と記号の除去。長音「ー」は残す）。 */
export function normalizeKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(PUNCT, "");
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

/** 小さい方のbigram集合のうち、もう一方にも含まれる割合（包含に強い類似度）。 */
export function keySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return 1;
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const g of sa) if (sb.has(g)) common++;
  return common / Math.min(sa.size, sb.size);
}

const SAME_SLOT_SIMILARITY = 0.6;

// ---------------------------------------------------------------------------
// 検証（LLMの候補 → 決定的に検証済みのdraft）
// ---------------------------------------------------------------------------

export type ProfileDropReason =
  | "schema"
  | "category"
  | "length"
  | "quote"
  | "not-user"
  | "sensitive"
  | "address"
  | "third-party"
  | "hedge"
  | "relative-time"
  | "unsafe"
  | "shape"
  | "duplicate"
  | "cap";

/** 機微情報の語彙（v1は保存しない）。これに一致しなかったことは、安全の根拠にしない（他の段階で狭く保つ）。 */
const SENSITIVE_PATTERN = new RegExp(
  [
    "病|疾患|診断|うつ|鬱|障害|障がい|癌|がん|服薬|投薬|処方|通院|入院|手術|治療|リハビリ|妊娠|不妊|流産|依存|アルコール|中毒|自殺|死にたい|自傷|虐待|ＤＶ|DV",
    "宗教|信仰|信者|教団|創価|統一教会|クリスチャン|仏教徒|イスラム|ムスリム",
    "性的|セクシュアル|ゲイ|レズビアン|バイセクシュアル|トランスジェンダー|LGBT|ＬＧＢＴ|同性愛|性自認",
    "年収|給料|給与|収入|貯金|貯蓄|借金|ローン|負債|破産|資産|預金|投資額|生活保護|滞納|税金",
    "逮捕|前科|犯罪|裁判|訴訟|刑務所|保釈",
    "政治|支持政党|投票|選挙|自民|民主党|共産党|公明|維新|人種|民族|国籍|在日|被差別|部落",
    "離婚|別居|不倫|浮気|死別|亡くな|他界|介護|認知症|パスワード|暗証|マイナンバー|口座|クレジット",
  ].join("|")
);

/** 詳細住所（番地・部屋・郵便番号・建物名）。居住はエリア（市区町村まで）だけを扱う。 */
const ADDRESS_PATTERN = /丁目|番地|[0-9０-９]+番|号室|〒|[0-9０-９]{3}[-ー−–][0-9０-９]{4}|[0-9０-９]{1,4}[-ー−–][0-9０-９]{1,4}[-ー−–][0-9０-９]{1,4}|マンション|アパート|ハイツ|コーポ|レジデンス|荘|団地|寮|社宅/;

/** 第三者の話（quoteの主語がユーザー以外）。 */
const THIRD_PARTY_PATTERN = /(友達|友人|同僚|上司|部下|先輩|後輩|知り合い|取引先|お客|客|彼|彼女|あの人|その人|[ぁ-んァ-ン一-龥ー]{1,5}さん|[ぁ-んァ-ン一-龥ー]{1,5}君|[ぁ-んァ-ン一-龥ー]{1,5}ちゃん)(は|が|の|も)/;

/** 仮定・伝聞・冗談・創作・迷い。 */
const HEDGE_PATTERN = /もし|仮に|たとえば|例えば|だとしたら|としたら|かもしれ|かも|かな[。？?！!]?$|だろう|でしょう|らしい|みたいな|みたいだ|ような|想像|妄想|冗談|ジョーク|ネタ|小説|映画|ドラマ|アニメ|ゲームの|ロールプレイ|設定/;

/** statementに含めない、相対的な時間語（statementは時間に依存しない言明にする）。 */
const RELATIVE_TIME_PATTERN = /今日|昨日|一昨日|明日|明後日|今月|先月|来月|再来月|今週|先週|来週|今年|去年|昨年|来年|最近|さっき|今度|そのうち|近々|今は|今も|もうすぐ/;

/** 人格・価値観・感情・関係状態（Profile v1に入れない）。 */
const STATE_WORDS = /うまくいっ|不仲|仲が|喧嘩|けんか|ケンカ|大切|大事|守りたい|壊したく|つら|辛|しんどい|悩|不安|心配|嫌|苦手|愛して|尊敬|感謝|ストレス|関係|価値観|信念|生き方|人生観|性格|恐れ|承認|自己肯定|理想|願い|幸せ|後悔|寂し/;

const RELATION_CUES: Record<HouseholdRelation, RegExp> = {
  partner: /妻|夫|配偶者|パートナー|奥さん|旦那|結婚/,
  child: /子|息子|娘|長男|長女|次男|次女|赤ちゃん/,
  parent: /父|母|親|両親|お父さん|お母さん/,
  sibling: /兄|弟|姉|妹|兄弟|姉妹/,
  pet: /犬|猫|ペット|飼|うさぎ|インコ/,
  other: /祖父|祖母|おじいちゃん|おばあちゃん|同居|叔父|叔母|甥|姪/,
};
const NEGATIVE_EXISTENCE = /いない|いません|ない[。！!]?$|ません[。！!]?$|なかった/;
const RESIDENCE_CUE = /住|在住|暮ら|引っ越|移住|転居/;
const OCCUPATION_CUE = /働|勤|仕事|職|会社|勤務|転職|退職|辞め|フリーランス|経営|起業|自営|業務|従事|所属|入社|独立/;
const PREFERENCE_CUE = /好き|好む|好み|苦手|嫌い|派|愛用|よく|いつも|必ず|使っている|使ってる|飲む|食べる|飲まない|食べない|聴く|読む/;
const PERSONALITY_WORDS = /大切にして|大事にして|価値観|信念|生き方|人生観|性格|恐れ|承認欲求|自己肯定/;

const BEGAN_CUE = /た(?:[。！!？?\s、,よね]|$)|ました|になった|に変わった|決まった|始めた|入った|んだ/;
const ENDED_CUE = /(辞め|退職|やめ|終わ|卒業|引退|閉じ|廃業|解散|手放|売っ|終え)(?:た|ました|てしまった)/;
const FORMER_CUE = /以前|昔|かつて|前は|元|これまで|以前は|前に/;
const PLANNED_HESITATION = /たい|かな|かも|しようか|たら|なら|ば[、,]/;
const PLANNED_FIRM = /予定|決まっ|決めた|つもり|来月|来週|来年|再来月|再来週|今度|する[。！!]?$|になる|になります|引っ越す|辞める|入社する|独立する/;

export interface ProfileClaimCandidate {
  category?: unknown;
  key?: unknown;
  relation?: unknown;
  value?: unknown;
  statement?: unknown;
  tense?: unknown;
  change?: unknown;
  stated?: unknown;
  quote?: unknown;
  validFromSource?: unknown;
  validFrom?: unknown;
  validFromPrecision?: unknown;
  confidence?: unknown;
}

/** 検証済みの候補。id・sourceConversationId・recordedAt・origin・schemaVersionは、保存時にTsumugiが付ける。 */
export interface ProfileClaimDraft {
  category: ProfileCategory;
  slot: string;
  /** slot生成の元（再検証用）。保存はしない。 */
  key?: string;
  relation?: HouseholdRelation;
  value?: string;
  statement: string;
  tense: ProfileTense;
  change: ProfileChange;
  stated: "explicit";
  quote: string;
  statedAt: string;
  validFrom?: string;
  validFromPrecision?: EventTimePrecision;
  confidence?: number;
}

export interface ProfileValidationContext {
  turns: ConversationTurn[];
  /** JST基準の今日（YYYY-MM-DD）。validFromSourceの解決に使う。 */
  todayJst: string;
  /** この呼び出しで受理する最大件数（既定：perMemoryItem） */
  maxItems?: number;
  /** quoteを含むturnにtimestampが無い場合の代替 */
  fallbackStatedAt?: string;
}

export interface ProfileValidationResult {
  drafts: ProfileClaimDraft[];
  proposed: number;
  dropped: Partial<Record<ProfileDropReason, number>>;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function buildSlot(category: string, key: string | undefined, relation: HouseholdRelation | undefined): string | null {
  if (category === "residence") return "residence:primary";
  if (category === "occupation") return "occupation:primary";
  if (category === "household") {
    if (!relation) return null;
    if (relation === "other") {
      const k = key ? normalizeKey(key) : "";
      return k ? `household:other:${k}` : null;
    }
    return `household:${relation}`;
  }
  const k = key ? normalizeKey(key) : "";
  return k ? `${category}:${k}` : null;
}

function claimKeyOfDraft(d: Pick<ProfileClaimDraft, "category" | "slot" | "tense" | "change" | "value" | "statement">): string {
  return [d.category, d.slot, d.tense, d.change, normalizeKey(d.value ?? d.statement)].join("|");
}

/**
 * LLMが出した候補を、決定的に検証する。外れた候補だけを個別に破棄する（Memory自体には影響しない）。
 * サーバー（/api/capture）で検証し、クライアント（capture.ts）でも同じ関数で再検証する（冪等）。
 * 「安全に判定できない」候補は保存しない（fail-closed）。
 */
export function validateProfileCandidates(raw: unknown, ctx: ProfileValidationContext): ProfileValidationResult {
  const dropped: Partial<Record<ProfileDropReason, number>> = {};
  const drop = (reason: ProfileDropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const list = Array.isArray(raw) ? raw : [];
  const result: ProfileClaimDraft[] = [];
  const seen = new Set<string>();
  const maxItems = ctx.maxItems ?? PROFILE_LIMITS.perMemoryItem;
  const userTurns = ctx.turns.filter((turn) => turn.role === "user");
  const aiTurns = ctx.turns.filter((turn) => turn.role !== "user");

  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      drop("schema");
      continue;
    }
    const c = item as ProfileClaimCandidate;

    // 1. 列挙・型
    const category = asTrimmedString(c.category);
    if (!category || !(PROFILE_CATEGORIES_V1 as readonly string[]).includes(category)) {
      drop("category");
      continue;
    }
    const tense = c.tense;
    const change = c.change;
    if (!TENSES.includes(tense as ProfileTense) || !CHANGES.includes(change as ProfileChange) || c.stated !== "explicit") {
      drop("schema");
      continue;
    }
    const statement = asTrimmedString(c.statement);
    const quote = asTrimmedString(c.quote);
    if (statement === undefined || quote === undefined) {
      drop("schema");
      continue;
    }

    // 2. 長さ
    const value = asTrimmedString(c.value) || undefined;
    const key = asTrimmedString(c.key) || undefined;
    if (
      statement.length < PROFILE_LIMITS.statementMin ||
      statement.length > PROFILE_LIMITS.statementMax ||
      quote.length < PROFILE_LIMITS.quoteMin ||
      quote.length > PROFILE_LIMITS.quoteMax ||
      (value !== undefined && value.length > PROFILE_LIMITS.valueMax) ||
      (key !== undefined && key.length > PROFILE_LIMITS.keyMax)
    ) {
      drop("length");
      continue;
    }

    // 3. quoteが、ユーザーturnに逐語で含まれること（AI発言にしか無い引用は根拠にしない）
    const nq = normalizeText(quote);
    const sourceTurn = userTurns.find((turn) => normalizeText(turn.content).includes(nq));
    if (!sourceTurn) {
      drop(aiTurns.some((turn) => normalizeText(turn.content).includes(nq)) ? "not-user" : "quote");
      continue;
    }

    // 4〜8. 機微情報・詳細住所・第三者・仮定/伝聞・相対的な時間語
    const all = `${quote}\n${statement}\n${value ?? ""}\n${key ?? ""}`;
    const nAll = all.normalize("NFKC");
    if (SENSITIVE_PATTERN.test(nAll)) {
      drop("sensitive");
      continue;
    }
    if (ADDRESS_PATTERN.test(nAll)) {
      drop("address");
      continue;
    }
    if (THIRD_PARTY_PATTERN.test(nq)) {
      drop("third-party");
      continue;
    }
    if (HEDGE_PATTERN.test(nq)) {
      drop("hedge");
      continue;
    }
    if (RELATIVE_TIME_PATTERN.test(statement.normalize("NFKC")) || (value && RELATIVE_TIME_PATTERN.test(value)) || (key && RELATIVE_TIME_PATTERN.test(key))) {
      drop("relative-time");
      continue;
    }
    if (PERSONALITY_WORDS.test(nAll)) {
      drop("unsafe");
      continue;
    }

    // 9. categoryごとの形（肯定的な手がかりを要求する。手がかりが無ければ保存しない）
    let relation: HouseholdRelation | undefined;
    const nStatement = statement.normalize("NFKC");
    if (category === "residence") {
      if (!value || !RESIDENCE_CUE.test(nStatement) || change === "ended") {
        drop("shape");
        continue;
      }
    } else if (category === "occupation") {
      if (!OCCUPATION_CUE.test(nStatement) || (!value && change !== "ended")) {
        drop("shape");
        continue;
      }
    } else if (category === "household") {
      const rel = asTrimmedString(c.relation);
      if (!rel || !HOUSEHOLD_RELATIONS.includes(rel as HouseholdRelation) || change === "ended") {
        drop("shape");
        continue;
      }
      relation = rel as HouseholdRelation;
      // 家族構成上の明示的な事実だけ（関係の状態・感情・価値観・否定の存在は含めない）
      if (!RELATION_CUES[relation].test(nStatement) || STATE_WORDS.test(nAll) || NEGATIVE_EXISTENCE.test(nStatement)) {
        drop("shape");
        continue;
      }
    } else if (category === "preference") {
      if (!key || !PREFERENCE_CUE.test(nStatement) || STATE_WORDS.test(nAll.replace(/苦手|嫌い?/g, ""))) {
        drop("shape");
        continue;
      }
    } else {
      // project / goal
      if (!key || STATE_WORDS.test(nAll)) {
        drop("shape");
        continue;
      }
    }

    // tense・changeの整合（quoteの表現に手がかりがあること）
    if (change === "began" && !BEGAN_CUE.test(nq)) {
      drop("shape");
      continue;
    }
    if (change === "ended" && !ENDED_CUE.test(nq)) {
      drop("shape");
      continue;
    }
    if (tense === "former" && change === "none" && !FORMER_CUE.test(nq)) {
      drop("shape");
      continue;
    }
    if (tense === "planned" && (PLANNED_HESITATION.test(nq) || !PLANNED_FIRM.test(nq) || change !== "none")) {
      drop("shape");
      continue;
    }
    if (change === "began" && tense !== "current") {
      drop("shape");
      continue;
    }
    if (change === "ended" && tense !== "former") {
      drop("shape");
      continue;
    }

    // 10. slot（決定的に付与）
    const slot = buildSlot(category, key, relation);
    if (!slot) {
      drop("shape");
      continue;
    }

    // 11. validFrom（固定語彙の解決、または会話に明示された絶対時間のみ）
    let validFrom: string | undefined;
    let validFromPrecision: EventTimePrecision | undefined;
    if (isValidEventTimeSource(c.validFromSource) && c.validFromSource !== "none") {
      validFrom = resolveEventTimeSourceDate(ctx.todayJst, c.validFromSource);
      validFromPrecision = "day";
    } else if (
      typeof c.validFrom === "string" &&
      isValidEventTimePrecision(c.validFromPrecision) &&
      isValidEventTimeValue(c.validFrom, c.validFromPrecision)
    ) {
      validFrom = c.validFrom;
      validFromPrecision = c.validFromPrecision;
    }

    // 12. statedAt（quoteを含むユーザーturnのtimestamp。決定的）
    const statedAt = isValidIso(sourceTurn.timestamp) ? sourceTurn.timestamp : ctx.fallbackStatedAt;
    if (!statedAt || !isValidIso(statedAt)) {
      drop("shape");
      continue;
    }

    const draft: ProfileClaimDraft = {
      category,
      slot,
      ...(key !== undefined ? { key } : {}),
      ...(relation !== undefined ? { relation } : {}),
      ...(value !== undefined ? { value } : {}),
      statement,
      tense: tense as ProfileTense,
      change: change as ProfileChange,
      stated: "explicit",
      quote,
      statedAt,
      ...(validFrom !== undefined ? { validFrom, validFromPrecision } : {}),
      ...(typeof c.confidence === "number" && c.confidence >= 0 && c.confidence <= 1 ? { confidence: c.confidence } : {}),
    };

    // 13. 重複・件数
    const dk = claimKeyOfDraft(draft);
    if (seen.has(dk)) {
      drop("duplicate");
      continue;
    }
    if (result.length >= maxItems) {
      drop("cap");
      continue;
    }
    seen.add(dk);
    result.push(draft);
  }

  return { drafts: result, proposed: list.length, dropped };
}

/** サーバーがクライアントへ返す、検証済みの候補の形（クライアントが同じ関数で再検証できる）。 */
export function draftsToCandidates(drafts: ProfileClaimDraft[]): ProfileClaimCandidate[] {
  return drafts.map((d) => ({
    category: d.category,
    ...(d.key !== undefined ? { key: d.key } : {}),
    ...(d.relation !== undefined ? { relation: d.relation } : {}),
    ...(d.value !== undefined ? { value: d.value } : {}),
    statement: d.statement,
    tense: d.tense,
    change: d.change,
    stated: d.stated,
    quote: d.quote,
    ...(d.validFrom !== undefined ? { validFrom: d.validFrom, validFromPrecision: d.validFromPrecision } : {}),
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
  }));
}

/** 検証済みdraftから、保存するclaimを作る（id・sourceConversationId・recordedAt・origin・schemaVersionはTsumugiが付与する）。 */
export function draftsToClaims(
  drafts: ProfileClaimDraft[],
  meta: { conversationId: string; recordedAt: string; newId: () => string }
): ProfileClaim[] {
  return drafts.map((d) => ({
    id: meta.newId(),
    category: d.category,
    slot: d.slot,
    ...(d.value !== undefined ? { value: d.value } : {}),
    statement: d.statement,
    tense: d.tense,
    change: d.change,
    stated: "explicit" as const,
    quote: d.quote,
    statedAt: d.statedAt,
    sourceConversationId: meta.conversationId,
    ...(d.validFrom !== undefined ? { validFrom: d.validFrom, validFromPrecision: d.validFromPrecision } : {}),
    recordedAt: meta.recordedAt,
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    origin: "ai-extracted" as const,
    schemaVersion: 1 as const,
  }));
}

export function claimKey(c: ProfileClaim): string {
  return claimKeyOfDraft({ category: c.category, slot: c.slot, tense: c.tense, change: c.change, value: c.value, statement: c.statement });
}

// ---------------------------------------------------------------------------
// 保存済みclaimの読み込み（fail-soft）と、UPDATE時のmerge
// ---------------------------------------------------------------------------

const MAX_STORED_ON_READ = 24;

/** 保存済み（Markdown・IndexedDB）のclaimを検証して読み込む。壊れたclaimは、そのclaimだけ捨てる（例外を投げない）。 */
export function sanitizeStoredProfileClaims(raw: unknown): ProfileClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileClaim[] = [];
  for (const item of raw) {
    if (out.length >= MAX_STORED_ON_READ) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const c = item as Record<string, unknown>;
    if (
      typeof c.id !== "string" ||
      !c.id ||
      typeof c.category !== "string" ||
      typeof c.slot !== "string" ||
      !c.slot ||
      typeof c.statement !== "string" ||
      !c.statement ||
      !TENSES.includes(c.tense as ProfileTense) ||
      !CHANGES.includes(c.change as ProfileChange) ||
      c.stated !== "explicit" ||
      typeof c.quote !== "string" ||
      !isValidIso(c.statedAt) ||
      typeof c.sourceConversationId !== "string" ||
      !c.sourceConversationId ||
      !isValidIso(c.recordedAt)
    ) {
      continue;
    }
    const validFromOk =
      typeof c.validFrom === "string" && isValidEventTimePrecision(c.validFromPrecision) && isValidEventTimeValue(c.validFrom, c.validFromPrecision);
    out.push({
      id: c.id,
      category: c.category,
      slot: c.slot,
      ...(typeof c.value === "string" && c.value ? { value: c.value } : {}),
      statement: c.statement,
      tense: c.tense as ProfileTense,
      change: c.change as ProfileChange,
      stated: "explicit",
      quote: c.quote,
      statedAt: c.statedAt as string,
      sourceConversationId: c.sourceConversationId,
      ...(validFromOk ? { validFrom: c.validFrom as string, validFromPrecision: c.validFromPrecision as EventTimePrecision } : {}),
      recordedAt: c.recordedAt as string,
      ...(typeof c.confidence === "number" ? { confidence: c.confidence } : {}),
      origin: "ai-extracted",
      schemaVersion: 1,
    });
  }
  return out;
}

/**
 * Capture UPDATE時のmerge。追加のみ：既存のclaimは編集も削除もしない。
 * 同じclaimKeyかつ同じ会話のclaimは追加しない。同じclaimKeyでも別会話のものは別の根拠として残す
 * （同一claimKeyは3件まで、1 Memoryは12件まで）。
 */
export function mergeProfileClaims(existing: ProfileClaim[] | undefined, incoming: ProfileClaim[]): ProfileClaim[] {
  const merged: ProfileClaim[] = [...(existing ?? [])];
  for (const claim of incoming) {
    if (merged.length >= PROFILE_LIMITS.perMemoryStored) break;
    const key = claimKey(claim);
    const same = merged.filter((m) => claimKey(m) === key);
    if (same.some((m) => m.sourceConversationId === claim.sourceConversationId)) continue;
    if (same.length >= PROFILE_LIMITS.perClaimKeyStored) continue;
    merged.push(claim);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// ビュー（派生。保存しない）
// ---------------------------------------------------------------------------

export type ProfileStatus = "current" | "planned" | "former" | "superseded";

export interface ProfileEvidence {
  claimId: string;
  memoryId: string;
  conversationId: string;
  statedAt: string;
  quote: string;
}

export interface ProfileFact {
  slot: string;
  category: ProfileCategory;
  value?: string;
  statement: string;
  status: ProfileStatus;
  /** 食い違う言明があり、現在値を確定できない（データは保持するが、会話には注入しない）。 */
  contested: boolean;
  /** 既存のcurrentと違う値の言明のうち、まだ昇格していないもの（件数）。 */
  pendingCount: number;
  evidence: ProfileEvidence[];
  distinctConversations: number;
  firstStatedAt: string;
  lastStatedAt: string;
  hasExplicitChange: boolean;
  validFrom?: string;
  validFromPrecision?: EventTimePrecision;
  supersededByClaimId?: string;
}

interface Entry {
  claim: ProfileClaim;
  memoryId: string;
}

interface Holder {
  entries: Entry[];
  rep: Entry;
  status: ProfileStatus;
  contested: boolean;
  contestedAt?: string;
  supersededByClaimId?: string;
}

const SINGLE_VALUED: readonly string[] = ["residence", "occupation"];

function valueKeyOf(c: ProfileClaim): string {
  return normalizeKey(c.value ?? c.statement);
}

function sameValue(a: ProfileClaim, b: ProfileClaim): boolean {
  const ka = valueKeyOf(a);
  const kb = valueKeyOf(b);
  return keySimilarity(ka, kb) >= SAME_SLOT_SIMILARITY;
}

function newHolder(entry: Entry, status: ProfileStatus): Holder {
  return { entries: [entry], rep: entry, status, contested: false };
}

function addEvidence(holder: Holder, entry: Entry) {
  holder.entries.push(entry);
  holder.rep = entry;
}

/** 終了（ended）の言明を根拠に加える。表示用の代表（statement・value）は、終了した事実そのものの言明のまま変えない。 */
function addEndingEvidence(holder: Holder, entry: Entry) {
  holder.entries.push(entry);
}

function toJstDate(iso: string): string {
  const ms = Date.parse(iso);
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** 新しいclaimの実効日（validFromがあればそれ、無ければstatedAt）が、基準時刻以降か（精度を考慮）。 */
function isEffectiveNotBefore(claim: ProfileClaim, referenceIso: string): boolean {
  if (claim.validFrom && claim.validFromPrecision) {
    const ref = toJstDate(referenceIso);
    const len = claim.validFromPrecision === "year" ? 4 : claim.validFromPrecision === "month" ? 7 : 10;
    return claim.validFrom >= ref.slice(0, len);
  }
  return Date.parse(claim.statedAt) >= Date.parse(referenceIso);
}

function lastStatedAtOf(holder: Holder): string {
  return holder.entries.reduce((max, e) => (Date.parse(e.claim.statedAt) > Date.parse(max) ? e.claim.statedAt : max), holder.entries[0].claim.statedAt);
}

function factOf(slot: string, category: ProfileCategory, holder: Holder, pendingCount: number): ProfileFact {
  const claims = holder.entries.map((e) => e.claim);
  const rep = holder.rep.claim;
  const times = claims.map((c) => Date.parse(c.statedAt));
  return {
    slot,
    category,
    ...(rep.value !== undefined ? { value: rep.value } : {}),
    statement: rep.statement,
    status: holder.status,
    contested: holder.contested,
    pendingCount,
    evidence: holder.entries.map((e) => ({
      claimId: e.claim.id,
      memoryId: e.memoryId,
      conversationId: e.claim.sourceConversationId,
      statedAt: e.claim.statedAt,
      quote: e.claim.quote,
    })),
    distinctConversations: new Set(claims.map((c) => c.sourceConversationId)).size,
    firstStatedAt: new Date(Math.min(...times)).toISOString(),
    lastStatedAt: new Date(Math.max(...times)).toISOString(),
    hasExplicitChange: claims.some((c) => c.change === "began"),
    ...(rep.validFrom !== undefined ? { validFrom: rep.validFrom, validFromPrecision: rep.validFromPrecision } : {}),
    ...(holder.supersededByClaimId !== undefined ? { supersededByClaimId: holder.supersededByClaimId } : {}),
  };
}

function findByValue(holders: Holder[], claim: ProfileClaim): Holder | undefined {
  return holders.find((h) => sameValue(h.rep.claim, claim));
}

/** 単一値のslot（居住・職業）。current更新は、tense・change・validFrom・statedAtから決定的に決める。曖昧なら既存currentを消さない。 */
function resolveSingle(slot: string, category: ProfileCategory, entries: Entry[]): ProfileFact[] {
  let current: Holder | null = null;
  const superseded: Holder[] = [];
  const formers: Holder[] = [];
  const planned: Holder[] = [];
  const pending = new Map<string, Entry[]>();

  const addTo = (list: Holder[], entry: Entry, status: ProfileStatus) => {
    const existing = findByValue(list, entry.claim);
    if (existing) addEvidence(existing, entry);
    else list.push(newHolder(entry, status));
  };
  const dropFulfilledPlan = (claim: ProfileClaim) => {
    for (let i = planned.length - 1; i >= 0; i--) if (sameValue(planned[i].rep.claim, claim)) planned.splice(i, 1);
  };
  const supersede = (next: Holder) => {
    if (current) {
      current.status = "superseded";
      current.supersededByClaimId = next.rep.claim.id;
      superseded.push(current);
    }
    current = next;
    current.contested = false;
    dropFulfilledPlan(next.rep.claim);
    for (const key of [...pending.keys()]) {
      const group = pending.get(key)!;
      if (group.some((e) => sameValue(e.claim, next.rep.claim))) pending.delete(key);
    }
  };
  const tryPromote = () => {
    if (!current) return;
    const cur: Holder = current;
    for (const [key, group] of pending) {
      // 旧currentの最新の根拠より新しい言明だけを数える（旧valueが再確認された後の、新しい別会話の言明が2件以上）
      const refTime = Date.parse(lastStatedAtOf(cur));
      const fresh = group.filter((e) => Date.parse(e.claim.statedAt) > refTime);
      const conversations = new Set(fresh.map((e) => e.claim.sourceConversationId));
      if (conversations.size >= 2) {
        const holder = newHolder(fresh[0], "current");
        for (const e of fresh.slice(1)) addEvidence(holder, e);
        supersede(holder);
        pending.delete(key);
        return;
      }
    }
  };

  for (const entry of entries) {
    const c = entry.claim;
    if (c.tense === "planned") {
      addTo(planned, entry, "planned"); // plannedは、currentを絶対に変えない
      continue;
    }
    if (c.tense === "current") {
      if (!current) {
        current = newHolder(entry, "current");
        dropFulfilledPlan(c);
        continue;
      }
      if (sameValue(current.rep.claim, c)) {
        addEvidence(current, entry);
        if (current.contested && current.contestedAt && Date.parse(c.statedAt) > Date.parse(current.contestedAt)) current.contested = false;
        continue;
      }
      if (c.change === "began") {
        if (isEffectiveNotBefore(c, lastStatedAtOf(current))) {
          supersede(newHolder(entry, "current"));
        } else {
          current.contested = true; // 実効日が既存の根拠より前＝順序が矛盾する言明。既存currentは保持する
          current.contestedAt = c.statedAt;
          const group = pending.get(valueKeyOf(c)) ?? [];
          group.push(entry);
          pending.set(valueKeyOf(c), group);
        }
        continue;
      }
      // 値が違うだけのcurrent（change: none）は、即上書きしない
      const key = valueKeyOf(c);
      const matched = [...pending.keys()].find((k) => keySimilarity(k, key) >= SAME_SLOT_SIMILARITY) ?? key;
      const group = pending.get(matched) ?? [];
      group.push(entry);
      pending.set(matched, group);
      tryPromote();
      continue;
    }
    // former
    if (c.change === "ended") {
      if (current && (c.value === undefined || sameValue(current.rep.claim, c))) {
        current.status = "former";
        addEndingEvidence(current, entry);
        formers.push(current);
        current = null;
      } else {
        addTo(formers, entry, "former"); // 別の値の終了は、現在値に触れない
      }
      continue;
    }
    addTo(formers, entry, "former");
    if (current && sameValue(current.rep.claim, c) && Date.parse(c.statedAt) > Date.parse(lastStatedAtOf(current))) {
      current.contested = true; // 「以前は〜だった」：現在値は不明になるが、データは消さない
      current.contestedAt = c.statedAt;
    }
  }

  const pendingCount = [...pending.values()].reduce((n, g) => n + g.length, 0);
  const facts: ProfileFact[] = [];
  if (current) facts.push(factOf(slot, category, current, pendingCount));
  for (const h of planned) facts.push(factOf(slot, category, h, 0));
  for (const h of formers) facts.push(factOf(slot, category, h, 0));
  for (const h of superseded) facts.push(factOf(slot, category, h, 0));
  return facts;
}

/** 多値のslot（家族構成・プロジェクト・目標・好み）。同じslotの中で、追加・終了・予定・過去を扱う。 */
function resolveMulti(slot: string, category: ProfileCategory, entries: Entry[]): ProfileFact[] {
  let current: Holder | null = null;
  const formers: Holder[] = [];
  const planned: Holder[] = [];

  for (const entry of entries) {
    const c = entry.claim;
    if (c.tense === "planned") {
      const existing = findByValue(planned, c);
      if (existing) addEvidence(existing, entry);
      else planned.push(newHolder(entry, "planned"));
      continue;
    }
    if (c.tense === "current") {
      if (!current) {
        current = newHolder(entry, "current");
        planned.length = 0;
      } else {
        addEvidence(current, entry);
        if (current.contested && current.contestedAt && Date.parse(c.statedAt) > Date.parse(current.contestedAt)) current.contested = false;
      }
      continue;
    }
    if (c.change === "ended") {
      if (current) {
        current.status = "former";
        addEndingEvidence(current, entry);
        formers.push(current);
        current = null;
      } else {
        const existing = findByValue(formers, c);
        if (existing) addEvidence(existing, entry);
        else formers.push(newHolder(entry, "former"));
      }
      continue;
    }
    const existing = findByValue(formers, c);
    if (existing) addEvidence(existing, entry);
    else formers.push(newHolder(entry, "former"));
    if (current && Date.parse(c.statedAt) > Date.parse(lastStatedAtOf(current))) {
      current.contested = true;
      current.contestedAt = c.statedAt;
    }
  }

  const facts: ProfileFact[] = [];
  if (current) facts.push(factOf(slot, category, current, 0));
  for (const h of planned) facts.push(factOf(slot, category, h, 0));
  for (const h of formers) facts.push(factOf(slot, category, h, 0));
  return facts;
}

/**
 * 全Memoryのclaimから、ProfileFactを計算する（保存しない派生ビュー）。
 * claimは`statedAt`の昇順（同時刻はid順）に処理する。v1のcategory以外は無視する。
 */
export function computeProfileFacts(memories: MemoryObject[]): ProfileFact[] {
  const entries: Entry[] = [];
  for (const memory of memories) {
    if (!memory.profileClaims || memory.profileClaims.length === 0) continue;
    for (const claim of sanitizeStoredProfileClaims(memory.profileClaims)) {
      if (!(PROFILE_CATEGORIES_V1 as readonly string[]).includes(claim.category)) continue;
      entries.push({ claim, memoryId: memory.id });
    }
  }
  entries.sort((a, b) => Date.parse(a.claim.statedAt) - Date.parse(b.claim.statedAt) || (a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0));

  // 多値categoryの表記ゆれは、slotのキー部分の類似度で同じslotにまとめる
  const canonical = new Map<string, string[]>();
  const groups = new Map<string, { category: ProfileCategory; entries: Entry[] }>();
  for (const e of entries) {
    const category = e.claim.category;
    let slot = e.claim.slot;
    if (!SINGLE_VALUED.includes(category) && category !== "household") {
      const list = canonical.get(category) ?? [];
      const keyPart = normalizeKey(slot.split(":").slice(1).join(":"));
      const found = list.find((s) => keySimilarity(normalizeKey(s.split(":").slice(1).join(":")), keyPart) >= SAME_SLOT_SIMILARITY);
      if (found) slot = found;
      else list.push(slot);
      canonical.set(category, list);
    }
    const g = groups.get(slot) ?? { category, entries: [] };
    g.entries.push(e);
    groups.set(slot, g);
  }

  const facts: ProfileFact[] = [];
  for (const [slot, g] of groups) {
    facts.push(...(SINGLE_VALUED.includes(g.category) ? resolveSingle(slot, g.category, g.entries) : resolveMulti(slot, g.category, g.entries)));
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Context Assembly（core / relevant）
// ---------------------------------------------------------------------------

export interface ProfileContextItem {
  text: string;
  category: string;
  kind: "current" | "planned";
}

export interface ProfileContext {
  core: ProfileContextItem[];
  relevant: ProfileContextItem[];
}

const TRIGGERS: { pattern: RegExp; categories: string[] }[] = [
  { pattern: /妻|夫|配偶者|パートナー|恋人|彼氏|彼女|結婚|子ども|子供|息子|娘|育児|子育て|家族|両親|父|母|兄|弟|姉|妹|ペット|犬|猫|実家|恋愛|デート|夫婦|家庭/, categories: ["household"] },
  { pattern: /仕事|職場|会社|上司|部下|同僚|転職|キャリア|残業|出勤|会議|業務|就職|退職|昇進|クライアント|取引先|独立|副業|プロジェクト|事業/, categories: ["occupation", "project", "goal"] },
  { pattern: /旅行|旅|出張|天気|引っ越|近所|通勤|通学|地元|観光|ホテル|電車|駅|地域|家賃|ドライブ|生活/, categories: ["residence", "household"] },
  { pattern: /食事|ご飯|ランチ|ディナー|買い物|買う|おすすめ|プレゼント|趣味|飲み物|コーヒー|お茶|レストラン|カフェ|服|好み|映画|音楽/, categories: ["preference"] },
  { pattern: /目標|将来|やりたい|夢|計画|始めたい|いつか|勉強|資格|作りたい/, categories: ["goal", "project"] },
];

/** 今回の発言が、その項目自体の「変化の完了」を述べている場合（単に話題にしているだけ・予定の話は含めない）。 */
const CHANGE_MARKERS: Record<string, RegExp> = {
  residence: /(?:引っ越し|移住し|転居し)(?:た|ました|てき)|引っ越して(?:きた|いる)|越した/,
  occupation: /(?:転職|退職|入社|独立|起業|異動)し(?:た|ました)|辞めた|辞めました/,
};

const RELATION_ORDER: Record<string, number> = { "household:partner": 0, "household:child": 1, "household:parent": 2, "household:sibling": 3, "household:pet": 4 };

function fractionInText(fact: string, text: string): number {
  const fb = bigrams(fact);
  if (fb.size === 0) return 0;
  const tb = bigrams(text);
  let hit = 0;
  for (const g of fb) if (tb.has(g)) hit++;
  return hit / fb.size;
}

const RELATIVE_WORD_FOR_PLANNED = /今日|明日|明後日|今月|来月|再来月|今週|来週|今年|来年|今度|そのうち|近々/;

function isStalePlan(fact: ProfileFact, nowMs: number): boolean {
  if (fact.validFrom && fact.validFromPrecision) {
    const today = toJstDate(new Date(nowMs).toISOString());
    const len = fact.validFromPrecision === "year" ? 4 : fact.validFromPrecision === "month" ? 7 : 10;
    return fact.validFrom < today.slice(0, len);
  }
  return nowMs - Date.parse(fact.lastStatedAt) > PROFILE_CONTEXT_LIMITS.plannedStaleDays * 86400000;
}

function itemOf(fact: ProfileFact): ProfileContextItem {
  return fact.status === "planned"
    ? { text: `予定：${fact.statement}`, category: fact.category, kind: "planned" }
    : { text: fact.statement, category: fact.category, kind: "current" };
}

/**
 * 今回の会話へ渡すProfileを選ぶ。coreは、十分な根拠がある家族構成・職業だけ（最大2件・80字。条件を満たさなければ0件）。
 * relevantは、今回の話題に関連するものだけ（最大4件・200字）。合計は最大6件・300字。
 * `userTexts[0]`は今回のユーザー発言、以降は直近のユーザー発言（重みを下げて使う）。
 */
export function selectProfileContext(facts: ProfileFact[], input: { userTexts: string[]; nowMs?: number }): ProfileContext {
  const L = PROFILE_CONTEXT_LIMITS;
  const nowMs = input.nowMs ?? Date.now();
  const texts = input.userTexts.map((t) => t.normalize("NFKC")).filter((t) => t.length > 0);
  const current = texts[0] ?? "";

  // 今回の発言が、その項目自体の変更を述べている場合は、そのcategoryのProfileは今回だけ注入しない（矛盾を避ける）
  const suppressed = new Set(Object.entries(CHANGE_MARKERS).filter(([, re]) => re.test(current)).map(([category]) => category));

  const eligible = facts.filter((f) => {
    if (suppressed.has(f.category)) return false;
    if (f.status === "current") return !f.contested;
    if (f.status === "planned") return !isStalePlan(f, nowMs) && !RELATIVE_WORD_FOR_PLANNED.test(f.statement.normalize("NFKC"));
    return false; // former / superseded は注入しない
  });

  // core：十分な根拠（2会話以上、または明示的な変化）を満たす家族構成・職業だけ。条件を満たさなければ0件。
  const coreCandidates = eligible
    .filter((f) => f.status === "current" && (f.category === "household" || f.category === "occupation") && (f.distinctConversations >= 2 || f.hasExplicitChange))
    .sort((a, b) => {
      const rank = (f: ProfileFact) => (f.category === "household" ? 0 : 1) * 10 + (RELATION_ORDER[f.slot] ?? 9);
      return rank(a) - rank(b) || Date.parse(b.lastStatedAt) - Date.parse(a.lastStatedAt);
    });
  const core: ProfileContextItem[] = [];
  const coreSlots = new Set<string>();
  let coreChars = 0;
  for (const f of coreCandidates) {
    if (core.length >= L.coreMaxItems) break;
    const item = itemOf(f);
    if (coreChars + item.text.length > L.coreMaxChars) continue;
    core.push(item);
    coreSlots.add(f.slot);
    coreChars += item.text.length;
  }

  // relevant：今回の話題に関連するものだけ
  const triggered = new Set<string>();
  texts.forEach((t, i) => {
    if (i > 2) return;
    for (const trig of TRIGGERS) if (trig.pattern.test(t)) trig.categories.forEach((c) => triggered.add(c));
  });
  const scored = eligible
    .filter((f) => !coreSlots.has(f.slot))
    .map((f) => {
      const factText = normalizeKey(`${f.statement}${f.value ?? ""}`);
      let lex = 0;
      texts.slice(0, 3).forEach((t, i) => {
        lex = Math.max(lex, fractionInText(factText, normalizeKey(t)) * (i === 0 ? 1 : 0.5));
      });
      const trigger = triggered.has(f.category);
      const recency = nowMs - Date.parse(f.lastStatedAt) < 60 * 86400000 ? 0.5 : 0;
      const score = (trigger ? 2 : 0) + lex * 3 + Math.min(f.distinctConversations, 2) * 0.5 + recency - (f.status === "planned" ? 0.5 : 0);
      return { f, trigger, lex, score };
    })
    .filter((s) => s.trigger || s.lex >= 0.34)
    .sort((a, b) => b.score - a.score || Date.parse(b.f.lastStatedAt) - Date.parse(a.f.lastStatedAt));

  const relevant: ProfileContextItem[] = [];
  const maxRelevantItems = Math.min(L.relevantMaxItems, L.totalMaxItems - core.length);
  const maxRelevantChars = Math.min(L.relevantMaxChars, L.totalMaxChars - coreChars);
  let relevantChars = 0;
  const usedSlots = new Set<string>();
  for (const s of scored) {
    if (relevant.length >= maxRelevantItems) break;
    if (usedSlots.has(`${s.f.slot}:${s.f.status}`)) continue;
    const item = itemOf(s.f);
    if (relevantChars + item.text.length > maxRelevantChars) continue;
    relevant.push(item);
    usedSlots.add(`${s.f.slot}:${s.f.status}`);
    relevantChars += item.text.length;
  }
  return { core, relevant };
}

/** /api/chatが受け取るProfileを、上限内に収まる形へ整える（クライアントが上限を超えて送っても、サーバー側で守る）。 */
export function sanitizeProfileContext(raw: unknown): ProfileContext {
  const L = PROFILE_CONTEXT_LIMITS;
  const empty: ProfileContext = { core: [], relevant: [] };
  if (typeof raw !== "object" || raw === null) return empty;
  const r = raw as { core?: unknown; relevant?: unknown };
  const clean = (list: unknown, maxItems: number, maxChars: number): ProfileContextItem[] => {
    if (!Array.isArray(list)) return [];
    const out: ProfileContextItem[] = [];
    let chars = 0;
    for (const item of list) {
      if (out.length >= maxItems) break;
      if (typeof item !== "object" || item === null) continue;
      const i = item as Record<string, unknown>;
      if (typeof i.text !== "string" || typeof i.category !== "string" || (i.kind !== "current" && i.kind !== "planned")) continue;
      const text = i.text.replace(/[\r\n]+/g, " ").trim();
      if (text.length === 0 || text.length > PROFILE_LIMITS.statementMax + 4 || chars + text.length > maxChars) continue;
      out.push({ text, category: i.category, kind: i.kind });
      chars += text.length;
    }
    return out;
  };
  const core = clean(r.core, L.coreMaxItems, L.coreMaxChars);
  const coreChars = core.reduce((n, i) => n + i.text.length, 0);
  const relevant = clean(r.relevant, Math.min(L.relevantMaxItems, L.totalMaxItems - core.length), Math.min(L.relevantMaxChars, L.totalMaxChars - coreChars));
  return { core, relevant };
}
