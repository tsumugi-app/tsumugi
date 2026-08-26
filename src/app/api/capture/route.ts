import type { ConversationTurn, MemoryType, Persona } from "@/lib/types";
import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";

export const runtime = "nodejs";

const MEMORY_TYPES: MemoryType[] = [
  "conversation",
  "diary",
  "idea",
  "emotion",
  "goal",
  "person",
  "event",
  "insight",
];

const PERSONA_LABEL: Record<Persona, string> = {
  companion: "Companion（温かく共感的な伴走者として話していた）",
  coach: "Coach（問いかけを通じて成長を支えようとしていた）",
  analyst: "Analyst（論理的にパターンを見出そうとしていた）",
};

/**
 * 呼び出し元（capture.ts）が参考情報として渡す、Memoryの軽量な形。
 * 「このConversationから既に生成済みのMemory」（existingMemories）と
 * 「別Conversationからのローカル検索による類似候補」（relatedMemories）の
 * 両方で、同じ形（id/summary/keywords）を使う。
 */
interface ExistingMemoryRef {
  id: string;
  summary: string;
  keywords: string[];
}

/**
 * MEMORY_ENGINE.md 2.2 Capture / AI_DESIGN.md Memory Pipeline「Memory Analysis」に対応する。
 * この処理はまだ他の記憶との接続(Connect)は行わない。
 *
 * 「1 Conversation → 1 Memory」ではなく、会話の中から意味のある単位ごとに複数のMemory候補を
 * 抽出する（Tsumugi Capture改善）。既存Memory（同一Conversationから既に生成済みのもの）に加え、
 * 別Conversationからローカル検索で見つけた少数の類似候補（relatedMemories）も参考情報として渡し、
 * 続きの話題は更新、新しい話題は新規として区別させる。統合するかどうかの判断は常にAI（この
 * プロンプト）が行い、類似度による自動統合はしない（capture.ts側のスコアリングは候補選定のみ）。
 */
const SYSTEM_PROMPT = `あなたはTsumugiという個人向けAIプロダクトの記憶エンジン(Memory Engine)の一部として、
会話をMemory Objectへ変換する「Capture」処理だけを担当します。あなたはユーザーとは会話しません。

役割:
- 会話の内容を、後から本人が読んで意味が通る自然な日本語の文章に要約する
- 検索やリンクの手がかりになるキーワードを抽出する
- この記憶がどんな性質を持つか(type)を判定する。1つの記憶が複数のtypeを同時に持ってよい

Memory候補の粒度（重要）:
- 会話の中から、後から見返す価値がある「意味のある単位」でMemory候補を作る。単に発言の数や
  文字数で機械的に分割しない。
- 「今日は暑かった」「駅前で猫を見た」「なんとなく眠い」のような小さな出来事の羅列は、無理に
  別々のMemoryに分割せず、自然にまとまる単位（例：その日の雑多な出来事、として1つ）にまとめてよい。
- 一方、「仕事の新しい挑戦について相談したい」「鍋を買いたい」「確定申告が面倒」のように、
  会話の中に明確に異なるテーマが複数存在する場合は、それぞれ別のMemory候補として扱う。
- 判断基準は「テーマ・対象が明確に別物かどうか」であり、話題が変わるたびに機械的に分けることでは
  ない。迷う場合はまとめすぎるより分けすぎる方を避け、自然な単位を優先する。

既存Memoryとの対応付け:
- このConversationから既に生成済みのMemoryが「既存Memory」として提示される場合がある。
- 今回の会話内容が、既存Memoryのいずれかと明確に同じ話題の続き・追加情報である場合は、
  その既存Memoryのidを結果のexistingMemoryIdに設定し、summary/content/keywords/typesを
  その話題の最新の状態（既存の内容＋今回分）に更新する。
- 今回の会話に登場する話題が既存Memoryのどれとも一致しない場合は、existingMemoryIdを
  付けずに新しいMemory候補として出力する。
- 既存Memoryのうち、今回の会話で全く触れられていないものは、出力に含めない
  （それらは変更されない。無理に毎回すべて出力し直す必要はない）。

別Conversationからの関連Memory候補との対応付け（重要）:
- 「既存Memory」とは別に、過去の別Conversationから機械的な検索で見つかった、話題が
  近い可能性のある「関連Memory候補」が提示される場合がある。
- これはあくまで候補であり、類似しているというだけで自動的に同じ記憶とはみなさない。
  「似ているが別の記憶」は、統合せず新しいMemoryとして残してよい（むしろ望ましい）。
  例：「マックのハッピーセットに興味がある」という関連候補に対して、今回の内容が
  「子供と一緒にハッピーセットのおもちゃを集めたい」であれば、話題は近いが新しい
  視点（子供と一緒に、という要素）を含むため、新規Memoryとして残してよい。
- 今回の会話内容が、関連Memory候補のいずれかと**明確に同一の出来事・関心・事実**を
  指している場合に限り、既存Memoryの場合と同じ扱いで、その候補のidをexistingMemoryId
  に設定して更新してよい。判断基準は既存Memoryの場合と同じ「明確に同じ話題」であり、
  関連Memory候補だからといって基準を緩めない。
- 迷う場合は統合せず、新しいMemory候補として出力する方を優先する。

厳守事項:
- 実際に語られていないことを作り出さない(事実の捏造禁止)
- この段階では他の記憶との関連付け(接続)は一切行わない。Memory候補同士・既存Memory同士の
  意味的な関連付けもここでは行わない（それはConnectの役割）
- 断定的すぎる解釈は避け、確信度(confidence)を正直に0〜1で示す
- summaryとcontentは会話が使われた言語（通常は日本語）で書く
- 必ず指定されたJSON形式のみで出力する

Memory grounding rules（記憶として保存してよい根拠の境界）:
1. Memoryとして保存する事実・経験・関心・意向・判断は、USER'S ACTUAL STATEMENTSに
   明示的に根拠があるものだけを採用する。
2. AI RESPONSESに含まれる提案、推測、質問、例、店名、サービス名、アプリ名、人物名、
   価値観、人物像、アイデア、予定などを、Userが述べた事実としてMemory化してはいけない。
   これに加えて、AIが説明した対象の特徴・属性・評価・形容・雰囲気・味・印象なども、
   Userが実際にそう述べていない限り、Userの好み・希望・事実として保存してはいけない。
   例：AI「落ち着いた雰囲気の店です」「パスタがおいしい店です」
   　→ Userがそれについて何も言っていなければ、「Userは落ち着いた店を好む」
   　　「Userはおいしいパスタを求めている」のようにUserの好みとして保存してはいけない。
3. AI RESPONSESはUSER'S ACTUAL STATEMENTSの意味や文脈を理解するためだけに使用する。
   AIによる説明・形容・評価も同様に、あくまで文脈理解のためだけに使う。
4. UserがAIの提案に明示的または文脈上明確に同意・選択・反応した場合、そのUser発言に
   基づいて、その対象への関心・選択・意向をMemory化してよい。
   例：AI「Obsidianで記録してみるのはどうですか？」User「それいいね」
   　→「Obsidianに関心を示した」はMemory化してよい。
   一方：AI「Obsidianで記録してみるのはどうですか？」User「なるほど」
   　→ UserがObsidianを使っている／関心がある、とは断定しない。
5. AIが会話中に新しく作った概念・テーマ・人物像・理論・メソッド・比喩などを、それだけを
   根拠としてUserの過去の関心や価値観として保存してはいけない。
6. Userが実際に述べた内容を超えて推測・補完しない。
7. Memoryの文章は、可能な限りUserが実際に話した具体的な内容に基づいて作成する。`;

function buildTranscript(turns: ConversationTurn[]): string {
  const userLines = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content)
    .join("\n");
  const aiLines = turns
    .filter((turn) => turn.role !== "user")
    .map((turn) => turn.content)
    .join("\n");

  return `=== USER'S ACTUAL STATEMENTS ===
${userLines}
=== END USER'S ACTUAL STATEMENTS ===

=== AI RESPONSES — CONTEXT ONLY ===
${aiLines}
=== END AI RESPONSES ===`;
}

function formatMemoryRefLines(memories: ExistingMemoryRef[]): string {
  return memories
    .map((memory) => `- id: ${memory.id}\n  summary: ${memory.summary}\n  keywords: ${memory.keywords.join(", ")}`)
    .join("\n");
}

function buildExistingMemoriesSection(existingMemories: ExistingMemoryRef[]): string {
  if (existingMemories.length === 0) {
    return "\n\n既存Memory: このConversationからはまだ何もMemoryが生成されていない。すべて新規として扱う。";
  }

  return `\n\n=== 既存Memory（このConversationから既に生成済み。今回の話題と一致するものだけ更新対象にする） ===\n${formatMemoryRefLines(existingMemories)}\n=== END 既存Memory ===`;
}

/**
 * capture.ts側のfindRelatedMemoriesFromOtherConversations()が、ローカルの
 * スコアリングだけで（AIを呼ばずに）見つけた、別Conversation由来の少数の候補。
 * 既存Memoryのセクションとは明確に分け、「類似度で見つかっただけで、同じ記憶とは
 * 限らない」ことをSYSTEM_PROMPT側の指示と合わせて伝える。
 */
function buildRelatedMemoriesSection(relatedMemories: ExistingMemoryRef[]): string {
  if (relatedMemories.length === 0) return "";

  return `\n\n=== 関連Memory候補（別のConversationから、ローカル検索で見つかった候補。類似しているだけで同じ記憶とは限らない） ===\n${formatMemoryRefLines(relatedMemories)}\n=== END 関連Memory候補 ===`;
}

/**
 * chat/route.ts と同じ理由（Gemini 3.6系の既定thinkingが重い）でthinking予算を明示する。
 * Captureは会話全体を読む処理なので、会話が長いほど予算を増やす。
 */
function computeThinkingBudget(transcript: string): number {
  const length = transcript.length;
  if (length < 300) return 128;
  if (length < 1000) return 384;
  return 768;
}

const MEMORIES_SCHEMA: AISchema = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      description: "今回の会話から抽出された、意味のある単位ごとのMemory候補（複数可）",
      items: {
        type: "object",
        properties: {
          existingMemoryId: {
            type: "string",
            description: "既存Memoryのいずれかの続き・更新である場合のみ、そのid。新規Memoryの場合は省略する",
          },
          summary: {
            type: "string",
            description: "この記憶をひと目で思い出せる一行の要約（20〜40文字程度）",
          },
          content: {
            type: "string",
            description: "後から読んで意味が通る2〜4文程度の文章。事実に加え、話し手の様子や気持ちも含めてよい",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "検索やリンクの手がかりになるキーワード（3〜8個）",
          },
          types: {
            type: "array",
            items: { type: "string", enum: MEMORY_TYPES },
            description: "この記憶が持つ性質（複数可）",
          },
          confidence: {
            type: "number",
            description: "この抽出結果に対する確信度（0〜1）",
          },
        },
        required: ["summary", "content", "keywords", "types", "confidence"],
      },
    },
  },
  required: ["memories"],
};

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("capture");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json(
      { error: "Gemini APIキーが設定されていません。" },
      { status: 401 }
    );
  }

  const { persona, turns, existingMemories, relatedMemories } = (await request.json()) as {
    persona: Persona;
    turns: ConversationTurn[];
    existingMemories?: ExistingMemoryRef[];
    relatedMemories?: ExistingMemoryRef[];
  };

  if (!turns || turns.length === 0) {
    return Response.json({ error: "turns is required" }, { status: 400 });
  }

  const transcript = `会話中のペルソナ: ${PERSONA_LABEL[persona] ?? persona}\n\n---\n\n${buildTranscript(turns)}${buildExistingMemoriesSection(existingMemories ?? [])}${buildRelatedMemoriesSection(relatedMemories ?? [])}`;

  const provider = getProvider(providerName);
  let response: { text: string };
  try {
    response = await provider.generateStructured({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: SYSTEM_PROMPT,
      userContent: transcript,
      providerOptions: { gemini: { thinkingBudget: computeThinkingBudget(transcript) } },
      schema: MEMORIES_SCHEMA,
    });
  } catch (error) {
    console.error("[Tsumugi Capture] generateContent failed:", error);
    return Response.json(
      { error: "Failed to generate a memory extraction from the AI model." },
      { status: 502 }
    );
  }

  const text = response.text;
  if (!text) {
    return Response.json(
      { error: "AI did not return a structured memory extraction." },
      { status: 502 }
    );
  }

  try {
    const parsed = JSON.parse(text);
    return Response.json(parsed);
  } catch {
    return Response.json(
      { error: "Failed to parse AI response as JSON." },
      { status: 502 }
    );
  }
}
