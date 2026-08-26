import type { ConversationTurn } from "@/lib/types";
import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";

/**
 * Test45〜71で確認した分業を実装する（/api/chatの会話生成とは独立した処理）。
 *
 * 1. LLMは「対象語がUser/Assistantそれぞれの発言に明示的に存在するか」という
 *    狭い二値判定だけを行う（Test65/69で高精度・Test66〜68で「両方」の自然言語
 *    統合や間接参照の判定はLLMにさせると崩れることを確認済み）。
 * 2. quote・speaker・turn_idはLLMに生成させない。LLMの二値判定を「どちらの
 *    ロールのturnを検索するか」を決める信号としてのみ使い、実際のEvidenceは
 *    Tsumugi側で会話ログを直接文字列検索して構築する（Test70でLLMにJSON全体を
 *    生成させると捏造・無関係turn混入が発生したため、Test71でこの分離を検証した）。
 * 3. 間接参照（「そのお店」等）はこの関数の対象外（Test68で単独では不安定と確認済み）。
 *    明示的な文字列一致のみを扱う。
 */

export interface FactEvidence {
  turnId: string;
  speaker: "user" | "assistant";
  quote: string;
}

/**
 * Test72での設計判断：Factは「原文に何が観測されたか」だけを表す最小モデルに留める。
 * relation/emotion/intent/preference/goalのような意味解釈は、まだここに混ぜない
 * （Fact本体はTest71で確立した文字列一致ベースの堅牢性を維持し、意味解釈は将来の
 * 別レイヤー「Semantic Interpretation」に委ねる）。
 */
export interface Fact {
  id: string;
  subject: string;
  evidence: FactEvidence[];
  createdAt: string;
}

const MENTION_SCHEMA: AISchema = {
  type: "object",
  properties: {
    userMentioned: {
      type: "boolean",
      description: "会話履歴の中で、Userの発言に対象語が明示的に含まれていればtrue",
    },
    assistantMentioned: {
      type: "boolean",
      description: "会話履歴の中で、Assistantの発言に対象語が明示的に含まれていればtrue",
    },
  },
  required: ["userMentioned", "assistantMentioned"],
};

function buildTurnsTranscript(turns: ConversationTurn[]): string {
  return turns
    .map((turn, index) => `[turn${index}] ${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");
}

export interface MentionResult {
  userMentioned: boolean;
  assistantMentioned: boolean;
}

/** LLMに「対象語の発言者」という狭い二値判定だけをさせる（Fact本体はここでは作らない）。 */
export async function checkSubjectMentions(
  subject: string,
  turns: ConversationTurn[],
  apiKey: string
): Promise<MentionResult> {
  const providerName = resolveProviderForFeature("factExtract");
  const provider = getProvider(providerName);

  const transcript = buildTurnsTranscript(turns);
  const userContent = `${transcript}\n\n以下の会話において、「${subject}」という対象について、Userが明示的に発言していますか？ Assistantが明示的に発言していますか？`;

  const response = await provider.generateStructured({
    model: resolveModel(providerName),
    apiKey,
    userContent,
    schema: MENTION_SCHEMA,
  });

  const parsed = JSON.parse(response.text) as Partial<MentionResult>;
  return {
    userMentioned: parsed.userMentioned === true,
    assistantMentioned: parsed.assistantMentioned === true,
  };
}

/**
 * LLMのmentionsを「どちらのロールを検索するか」の信号として使い、実際のEvidenceは
 * turnsを直接文字列検索して構築する。quoteは常にturn.contentからのコピーであり、
 * LLMの出力を経由しない。
 */
export function buildFact(subject: string, turns: ConversationTurn[], mentions: MentionResult): Fact | null {
  const evidence: FactEvidence[] = [];

  turns.forEach((turn, index) => {
    if (!turn.content.includes(subject)) return;
    if (turn.role === "user" && !mentions.userMentioned) return;
    if (turn.role === "ai" && !mentions.assistantMentioned) return;
    evidence.push({
      turnId: `turn${index}`,
      speaker: turn.role === "user" ? "user" : "assistant",
      quote: turn.content,
    });
  });

  if (evidence.length === 0) return null;
  return { id: crypto.randomUUID(), subject, evidence, createdAt: new Date().toISOString() };
}
