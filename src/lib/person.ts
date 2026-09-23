/**
 * Person Memory v1（Personal Modelの第三者層）。
 *
 * 【構造】
 * - ソース層（保存）：Captureが、ユーザー自身の明示的な発言から見つけた第三者への言及を
 *   `PersonMention`として`MemoryObject.personMentions`に付ける（追加のみ）。専用の
 *   IndexedDB store・Vault folder・Person Entityは作らない。
 * - ビュー層（計算のみ）：全Memoryのmentionから、`PersonView`（人物軸で束ねたMemory群・
 *   現在有効と判定されたrelation）を決定的に計算する。保存しない。
 *
 * 【Personal Profileとの分離】
 * Personal Profile（profile.ts）＝ユーザー本人についての安定した前提。
 * Person Memory（本ファイル）＝会話に登場する第三者についての人物軸。
 * 両者は明確に別の対象を扱うため、型・保存領域・validationロジックを共有しない
 * （`normalizeKey`/`normalizeText`のみ、読み取り専用でprofile.tsから再利用する）。
 *
 * 【原則】
 * - LLMが出すのは候補だけ。id・groupingKey・statedAt・sourceConversationId・
 *   recordedAt等は、Tsumugi側が決定的に付与する。
 * - 明示的なユーザー発言だけを根拠にする（quoteはユーザーturnに逐語で含まれること、
 *   かつ対象人物のdisplayName自体もquote内に確認できること）。AIの推測
 *   （性格・感情・意図・好意・関係の良し悪し・人物像）は保存しない。
 * - `groupingKey`は`normalizeKey(displayName)`によるv1の安全な束ね単位であり、
 *   恒久的なPerson IDではない。異なる呼称（「さきさん」と「妻」等）をAIの推測だけで
 *   自動的に同一人物として統合することはしない（既知の限界）。
 * - Correction（Userによる既存relationの明示的な否定・訂正）は、LLMの自己申告だけでは
 *   成立させない。quote本文に対する決定的な検証（対象人物・negation particle・
 *   否定対象relationの代表語・置き換え後relationの代表語）をすべて通った場合にのみ
 *   `assertion:"correction"`として成立する（`validateCorrectionShape`参照）。
 *   Correctionが既存の値と一致しない場合はPersonView計算時にも適用しない
 *   （fail-closed。二重の安全策）。
 * - Change（「以前は〜だったが今は〜」のような時間経過による状態変化）は今回モデル化
 *   しない（Current State、将来フェーズのスコープ）。判定に迷う場合は常に既存情報を
 *   破壊しない側へ倒す（`relationContested`を立てるだけで、現在値は上書きしない）。
 *
 * このモジュールはサーバー（/api/capture）とクライアントの両方から使う純粋関数だけを持つ。
 */
import { normalizeKey, normalizeText } from "./profile";
import { PERSON_RELATIONS, type ConversationTurn, type ID, type MemoryObject, type PersonMention, type PersonRelation, type PersonRelationCorrection } from "./types";

export const PERSON_MEMORY_LIMITS = {
  displayNameMax: 20,
  quoteMin: 2,
  quoteMax: 80,
  /** 1つのMemory候補（Capture出力の1項目）あたり */
  perMemoryItem: 5,
  /** 1回のCapture全体 */
  perCapture: 8,
  /** 1つのMemoryに保存する上限（超えたら新しい重複から捨てる。既存mentionは削除しない） */
  perMemoryStored: 12,
  /** 同じgroupingKeyの保存上限（別Conversationの根拠として残す） */
  perGroupingKeyStored: 6,
} as const;

const PERSON_RELATION_SET: readonly string[] = PERSON_RELATIONS;

/**
 * 各relationカテゴリの代表的な語彙。profile.tsの`RELATION_CUES`（HouseholdRelation用）と
 * 同じ考え方だが、PersonRelationは家族に限らず同僚・上司・友人・知人も含むため独立して持つ
 * （HouseholdRelationとは別の型であり、意図的にimportし直さない）。
 */
const PERSON_RELATION_WORDS: Record<PersonRelation, RegExp> = {
  spouse: /妻|夫|配偶者|パートナー|奥さん|旦那/,
  child: /子|息子|娘|長男|長女|次男|次女|三男|三女/,
  parent: /父|母|親|お父さん|お母さん/,
  sibling: /兄|弟|姉|妹|兄弟|姉妹/,
  pet: /犬|猫|ペット|飼|うさぎ|インコ/,
  colleague: /同僚|仕事仲間/,
  boss: /上司|部長|課長|社長|マネージャー/,
  friend: /友人|友達|親友/,
  acquaintance: /知り合い|知人/,
  other: /祖父|祖母|叔父|叔母|甥|姪|先輩|後輩/,
};

/**
 * Correctionの判定に使う、relationの明示的な否定を表す狭いnegation particleのみ。
 * 「実は」「間違い」「違う」「訂正」のような一般的な談話標識は意図的に含めない
 * ——それらは「さきさんは同僚だけど、考え方は自分とは違う」「実は昨日さきさんと仕事した」
 * のような、relationのCorrectionとは無関係な文脈でも頻出し、誤検出を招くため。
 */
const RELATION_NEGATION = /じゃな(い|く)|ではな(い|く)/;

export type PersonMentionDropReason =
  | "schema"
  | "displayName"
  | "quote"
  | "not-user"
  | "relation"
  | "cap";

function isValidRelation(value: unknown): value is PersonRelation {
  return typeof value === "string" && PERSON_RELATION_SET.includes(value);
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Correctionの決定的検証（実装方針：LLMの自己申告だけでCorrectionを確定しない）。
 * quote本文から、以下がすべて確認できた場合にのみCorrectionとして成立させる：
 * 1. 明示的なnegation particle（じゃない/じゃなく/ではない/ではなく）がquoteに含まれる
 * 2. invalidatesRelationの代表語がquoteに含まれる
 * 3. replacementRelationが指定されている場合、その代表語もquoteに含まれ、
 *    invalidatesRelationと異なること
 * 1つでも満たさなければnullを返す（呼び出し元がcorrectionを無視し、通常のmentionへ
 * 格下げする。displayName/quote自体が別途有効ならmentionとしては採用され続ける）。
 */
function validateCorrectionShape(
  nq: string,
  invalidatesRelationRaw: unknown,
  replacementRelationRaw: unknown
): PersonRelationCorrection | null {
  if (!isValidRelation(invalidatesRelationRaw)) return null;
  if (!RELATION_NEGATION.test(nq)) return null;
  if (!PERSON_RELATION_WORDS[invalidatesRelationRaw].test(nq)) return null;

  if (replacementRelationRaw === undefined) {
    return { invalidatesRelation: invalidatesRelationRaw };
  }
  if (!isValidRelation(replacementRelationRaw)) return null;
  if (replacementRelationRaw === invalidatesRelationRaw) return null;
  if (!PERSON_RELATION_WORDS[replacementRelationRaw].test(nq)) return null;
  return { invalidatesRelation: invalidatesRelationRaw, replacementRelation: replacementRelationRaw };
}

/** LLMが返す生の候補（Capture structured output）。 */
export interface PersonMentionCandidate {
  displayName?: unknown;
  relation?: unknown;
  quote?: unknown;
  correction?: {
    invalidatesRelation?: unknown;
    replacementRelation?: unknown;
  };
}

/** 検証済みの候補。id・sourceConversationId・recordedAtは、保存時にTsumugiが付ける。 */
export interface PersonMentionDraft {
  groupingKey: string;
  displayName: string;
  relation?: PersonRelation;
  assertion: "mention" | "correction";
  correction?: PersonRelationCorrection;
  quote: string;
  statedAt: string;
}

export interface PersonMentionValidationContext {
  turns: ConversationTurn[];
  /** この呼び出しで受理する最大件数（既定：perMemoryItem） */
  maxItems?: number;
  /** quoteを含むturnにtimestampが無い場合の代替 */
  fallbackStatedAt?: string;
}

export interface PersonMentionValidationResult {
  drafts: PersonMentionDraft[];
  proposed: number;
  dropped: Partial<Record<PersonMentionDropReason, number>>;
}

/**
 * LLMが出した候補を、決定的に検証する。外れた候補だけを個別に破棄する（Memory自体には影響しない）。
 * サーバー（/api/capture）で検証し、クライアント（capture.ts）でも同じ関数で再検証する（冪等）。
 * 「安全に判定できない」候補は保存しない（fail-closed）。
 */
export function validatePersonMentionCandidates(
  raw: unknown,
  ctx: PersonMentionValidationContext
): PersonMentionValidationResult {
  const dropped: Partial<Record<PersonMentionDropReason, number>> = {};
  const drop = (reason: PersonMentionDropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const list = Array.isArray(raw) ? raw : [];
  const result: PersonMentionDraft[] = [];
  const maxItems = ctx.maxItems ?? PERSON_MEMORY_LIMITS.perMemoryItem;
  const userTurns = ctx.turns.filter((turn) => turn.role === "user");
  const aiTurns = ctx.turns.filter((turn) => turn.role !== "user");

  for (const item of list) {
    if (result.length >= maxItems) {
      drop("cap");
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      drop("schema");
      continue;
    }
    const c = item as PersonMentionCandidate;

    const displayName = typeof c.displayName === "string" ? c.displayName.trim() : "";
    const quote = typeof c.quote === "string" ? c.quote.trim() : "";
    if (!displayName || displayName.length > PERSON_MEMORY_LIMITS.displayNameMax) {
      drop("displayName");
      continue;
    }
    if (!quote || quote.length < PERSON_MEMORY_LIMITS.quoteMin || quote.length > PERSON_MEMORY_LIMITS.quoteMax) {
      drop("quote");
      continue;
    }

    // 1. quoteが、ユーザーturnに逐語で含まれること（AI発言にしか無い引用は根拠にしない）
    const nq = normalizeText(quote);
    const sourceTurn = userTurns.find((turn) => normalizeText(turn.content).includes(nq));
    if (!sourceTurn) {
      drop(aiTurns.some((turn) => normalizeText(turn.content).includes(nq)) ? "not-user" : "quote");
      continue;
    }
    // 2. 対象人物（displayName）自体がquote内に確認できること（第三者への言及であることの根拠）。
    if (!nq.includes(normalizeText(displayName))) {
      drop("displayName");
      continue;
    }

    let relation: PersonRelation | undefined;
    if (c.relation !== undefined) {
      if (!isValidRelation(c.relation)) {
        drop("relation");
        continue;
      }
      relation = c.relation;
    }

    // 3. Correction（LLMの自己申告だけでは確定しない。quote本文への決定的な検証を通った
    //    場合にのみ成立する。落ちた場合は通常のmentionへfail-closedに格下げする）。
    let assertion: "mention" | "correction" = "mention";
    let correction: PersonRelationCorrection | undefined;
    if (c.correction !== undefined && typeof c.correction === "object" && c.correction !== null) {
      const validated = validateCorrectionShape(nq, c.correction.invalidatesRelation, c.correction.replacementRelation);
      if (validated) {
        assertion = "correction";
        correction = validated;
        relation = validated.replacementRelation ?? relation;
      }
    }

    const statedAt = isValidIso(sourceTurn.timestamp) ? sourceTurn.timestamp : ctx.fallbackStatedAt;
    if (!statedAt || !isValidIso(statedAt)) {
      drop("schema");
      continue;
    }

    result.push({
      groupingKey: normalizeKey(displayName),
      displayName,
      ...(relation !== undefined ? { relation } : {}),
      assertion,
      ...(correction !== undefined ? { correction } : {}),
      quote,
      statedAt,
    });
  }

  return { drafts: result, proposed: list.length, dropped };
}

/**
 * サーバー（/api/capture）が検証済みdraftをクライアントへ返す際の中間形（`PersonMentionCandidate`と
 * 同じ形）。クライアント（capture.ts）が同じ`validatePersonMentionCandidates`で再検証してから
 * `draftsToPersonMentions`で最終的なPersonMentionを組み立てる（Profile v1の
 * `draftsToCandidates`と同じ二重検証パターン）。
 */
export function draftsToPersonMentionCandidates(drafts: PersonMentionDraft[]): PersonMentionCandidate[] {
  return drafts.map((d) => ({
    displayName: d.displayName,
    ...(d.relation !== undefined ? { relation: d.relation } : {}),
    quote: d.quote,
    ...(d.correction !== undefined ? { correction: d.correction } : {}),
  }));
}

/** 検証済みdraftから、保存するmentionを作る（id・sourceConversationId・recordedAt・origin・schemaVersionはTsumugiが付与する）。 */
export function draftsToPersonMentions(
  drafts: PersonMentionDraft[],
  meta: { conversationId: string; recordedAt: string; newId: () => string }
): PersonMention[] {
  return drafts.map((d) => ({
    id: meta.newId(),
    groupingKey: d.groupingKey,
    displayName: d.displayName,
    ...(d.relation !== undefined ? { relation: d.relation } : {}),
    assertion: d.assertion,
    ...(d.correction !== undefined ? { correction: d.correction } : {}),
    stated: "explicit" as const,
    quote: d.quote,
    statedAt: d.statedAt,
    sourceConversationId: meta.conversationId,
    recordedAt: meta.recordedAt,
    origin: "ai-extracted" as const,
    schemaVersion: 1 as const,
  }));
}

// ---------------------------------------------------------------------------
// 保存済みmentionの読み込み（fail-soft）と、UPDATE時のmerge
// ---------------------------------------------------------------------------

const MAX_STORED_ON_READ = 24;

/** 保存済み（Markdown・IndexedDB）のmentionを検証して読み込む。壊れたmentionは、そのmentionだけ捨てる（例外を投げない）。 */
export function sanitizeStoredPersonMentions(raw: unknown): PersonMention[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonMention[] = [];
  for (const item of raw) {
    if (out.length >= MAX_STORED_ON_READ) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const m = item as Record<string, unknown>;
    if (
      typeof m.id !== "string" ||
      !m.id ||
      typeof m.groupingKey !== "string" ||
      !m.groupingKey ||
      typeof m.displayName !== "string" ||
      !m.displayName ||
      (m.assertion !== "mention" && m.assertion !== "correction") ||
      m.stated !== "explicit" ||
      typeof m.quote !== "string" ||
      !isValidIso(m.statedAt) ||
      typeof m.sourceConversationId !== "string" ||
      !m.sourceConversationId ||
      !isValidIso(m.recordedAt)
    ) {
      continue;
    }
    if (m.relation !== undefined && !isValidRelation(m.relation)) continue;

    let correction: PersonRelationCorrection | undefined;
    if (m.assertion === "correction") {
      const rawCorrection = m.correction as Record<string, unknown> | undefined;
      if (!rawCorrection || !isValidRelation(rawCorrection.invalidatesRelation)) continue;
      if (rawCorrection.replacementRelation !== undefined && !isValidRelation(rawCorrection.replacementRelation)) continue;
      correction = {
        invalidatesRelation: rawCorrection.invalidatesRelation,
        ...(rawCorrection.replacementRelation !== undefined ? { replacementRelation: rawCorrection.replacementRelation } : {}),
      };
    }

    out.push({
      id: m.id,
      groupingKey: m.groupingKey,
      displayName: m.displayName,
      ...(m.relation !== undefined ? { relation: m.relation as PersonRelation } : {}),
      assertion: m.assertion,
      ...(correction !== undefined ? { correction } : {}),
      stated: "explicit",
      quote: m.quote,
      statedAt: m.statedAt as string,
      sourceConversationId: m.sourceConversationId,
      recordedAt: m.recordedAt as string,
      origin: "ai-extracted",
      schemaVersion: 1,
    });
  }
  return out;
}

/**
 * Capture UPDATE時のmerge。追加のみ：既存のmentionは編集も削除もしない
 * （Correctionも含め、履歴を破壊しない。現在有効な情報はPersonView計算時に決める）。
 * 同じgroupingKeyかつ同じ会話・同じquoteのmentionは追加しない（retryでの重複防止）。
 */
export function mergePersonMentions(existing: PersonMention[] | undefined, incoming: PersonMention[]): PersonMention[] {
  const merged: PersonMention[] = [...(existing ?? [])];
  for (const mention of incoming) {
    if (merged.length >= PERSON_MEMORY_LIMITS.perMemoryStored) break;
    const sameGroup = merged.filter((m) => m.groupingKey === mention.groupingKey);
    if (sameGroup.some((m) => m.sourceConversationId === mention.sourceConversationId && m.quote === mention.quote)) continue;
    if (sameGroup.length >= PERSON_MEMORY_LIMITS.perGroupingKeyStored) continue;
    merged.push(mention);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Person View（派生。保存しない）
// ---------------------------------------------------------------------------

/**
 * Person → 関連Memory群、という逆引きの入口。保存しない派生ビューで、全MemoryObjectの
 * `personMentions`をgroupingKeyで束ねるたびに計算し直す（ProfileFactと同じ設計）。
 */
export interface PersonView {
  groupingKey: string;
  /** このgroupingKeyの最新mentionのdisplayName。 */
  displayName: string;
  /** 現在有効と判定されたrelation（無ければ未設定＝relation不明）。 */
  relation?: PersonRelation;
  /** relationについて、自動では確定できない矛盾が観測された状態
   *  （Correctionでない通常の食い違い、またはCorrectionの対象が現在値と一致しない場合）。 */
  relationContested: boolean;
  /** このgroupingKeyを持つ全MemoryのID（重複排除、出現順）。 */
  memoryIds: ID[];
}

/**
 * 全MemoryObjectの`personMentions`から、groupingKeyごとにPersonViewを計算する。
 *
 * relationの畳み込み：各groupingKeyのmentionをstatedAt昇順に処理する。
 * - 初めてrelationを述べたmentionをcurrentとする
 * - 同じrelationの再言明 → contestedを解消する（矛盾が解消したとみなす）
 * - 異なるrelationで、かつ`assertion==="correction"`かつ`correction.invalidatesRelation`が
 *   現在のcurrentと一致する場合のみ → currentを`correction.replacementRelation`へ更新する
 *   （Correctionが実際に何を訂正しているかが、現在追跡中の値と整合する場合だけ適用する。
 *   Capture時の検証だけでなく、ここでも整合性を再確認する二重の安全策）
 * - それ以外（通常の食い違い、またはCorrectionの対象が現在値と一致しない）→
 *   currentは変更せず、contestedだけ立てる（推測で上書きしない）
 */
export function computePersonViews(memories: MemoryObject[]): PersonView[] {
  const byGroup = new Map<string, { memoryId: string; mention: PersonMention }[]>();
  for (const memory of memories) {
    for (const mention of memory.personMentions ?? []) {
      const list = byGroup.get(mention.groupingKey) ?? [];
      list.push({ memoryId: memory.id, mention });
      byGroup.set(mention.groupingKey, list);
    }
  }

  const views: PersonView[] = [];
  for (const [groupingKey, entries] of byGroup) {
    entries.sort((a, b) => Date.parse(a.mention.statedAt) - Date.parse(b.mention.statedAt));

    let displayName = entries[0].mention.displayName;
    let relation: PersonRelation | undefined;
    let contested = false;
    const memoryIds: ID[] = [];
    const seenMemoryIds = new Set<string>();

    for (const { memoryId, mention } of entries) {
      if (!seenMemoryIds.has(memoryId)) {
        seenMemoryIds.add(memoryId);
        memoryIds.push(memoryId);
      }
      displayName = mention.displayName; // 最新の呼び方を採用

      if (mention.relation === undefined) continue;

      if (relation === undefined) {
        relation = mention.relation;
        continue;
      }
      if (mention.relation === relation) {
        contested = false; // 再確認により矛盾が解消したとみなす
        continue;
      }
      if (mention.assertion === "correction" && mention.correction?.invalidatesRelation === relation) {
        relation = mention.correction.replacementRelation;
        contested = false;
        continue;
      }
      contested = true;
    }

    views.push({ groupingKey, displayName, relation, relationContested: contested, memoryIds });
  }
  return views;
}

/** 特定のgroupingKeyについてだけPersonViewを取り出す。 */
export function computePersonView(memories: MemoryObject[], groupingKey: string): PersonView | undefined {
  return computePersonViews(memories).find((view) => view.groupingKey === groupingKey);
}
