import type { ConversationTurn, MemoryType, Persona } from "@/lib/types";
import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import { getJstTodayDateString, isValidEventTimeSource, resolveEventTimeSourceDate } from "@/lib/eventTimeResolver";

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

Topic判定（重要。existingMemoryIdによるUPDATE/CREATE判定とは完全に別の軸）:
- 「同じMemoryの更新か・新規Memoryか」（existingMemoryId）とは別に、「今後も同じ話の
  続きとして扱うべき、続いているテーマ（Topic）かどうか」を判定する。同じMemoryの
  更新でなくても（＝新規Memoryとして出力する場合でも）、既存Memory・関連Memory候補の
  どれかと同じ大きなテーマの続きであることは十分にありうる。
- 判断基準は「単なる共通の単語が含まれているか」ではなく「今後も同じ話の続きとして
  扱うべきテーマか」。以下の結果のいずれか1つを「topicDecision」に設定する：
  - sameTopic: 既存Memory・関連Memory候補のうちどれか1つと、明確に同じ継続的テーマ
    である場合。この場合、その候補のidを「sameTopicMemoryId」に設定する。
    例：過去に「08小隊」「サイサリス」「ZZ」というガンダム関連のMemoryがあり、今回
    「ガンダムの話をしよう」という会話があった場合、これはsameTopicとして妥当
    （具体的な単語が完全一致していなくても、同じ継続的テーマだと明確に言える）。
  - newTopic: 既存Memory・関連Memory候補のどれとも明確に異なる、新しい継続的テーマ
    だと言える場合。
    例：過去に「レンタカー事業」の話をしていて、今回「ガンダムの話をしよう」という
    会話があった場合、これは必ず別Topic（newTopまたはuncertain、sameTopicにはしない）。
  - uncertain: sameTopicともnewTopicとも明確には言えない場合。弱い関連・単なる連想
    だけでsameTopicと判定しない（迷う場合は必ずuncertainを選ぶ）。
    例：過去に「ガンダム」というテーマのMemoryがあり、今回「最近アニメあまり見てない」
    という一般的な発言があった場合、ガンダムというテーマへ無理に接続せず、uncertain
    （またはnewTopic）とする。
- Topic判定はexistingMemoryIdの有無に関わらず必ず行う（新規Memoryとして出力する場合も
  topicDecisionを必ず設定する）。

Event Time判定（出来事の時間。existingMemoryId・topicDecisionとは別の軸、必須の軸）:
- 「いつ話したか」（Conversation自体の時間）とは別に、「その記憶が表す出来事が実際に
  いつ起きた（起きる）か」を、Memory候補ごとに必ず1回判断する（省略しない）。
- 【必須】まず、その記憶の中心的な出来事が「今日」「昨日」「一昨日」「明日」「明後日」の
  いずれかに対応するかを判断し、eventTimeSourceへ必ず設定する。
  - 対応する場合：実際の日付は自分で計算せず、該当する表現（today/yesterday/
    day-before-yesterday/tomorrow/day-after-tomorrow）だけを設定する。実際の日付は
    Tsumugi側があなたのリクエストを処理した基準日から確定するため、eventTime/
    eventTimePrecisionは省略してよい。
  - 対応しない、または確信が持てない場合："none"を設定する（安全な既定値。少しでも
    根拠が薄ければ必ず"none"を選ぶ）。
- eventTimeSourceの判断は「その単語が文中のどこかに存在するか」ではなく「その記憶の
  中心的な出来事そのものを表しているか」で行う。
  - 肯定例：「昨日、公園を散歩した」という記憶 → eventTimeSource: "yesterday"
    （「昨日」が記憶の中心的な出来事そのものの時間）
  - 否定例：「昨日から考えているけど、2026年12月に会社を辞める」という記憶 →
    eventTimeSource: "none"（「昨日」は考え始めた時点であり、記憶の中心的な出来事
    ＝退職の時間ではない。「昨日」が文中に存在するというだけの理由で機械的に
    eventTimeSource: "yesterday"を選んではいけない。退職の時間そのものは下記の通り
    eventTime: "2026-12", eventTimePrecision: "month"として別途扱う）
- eventTimeSourceが"none"の場合でも、以下に該当すれば追加でeventTime/
  eventTimePrecisionを設定してよい（これは計算ではなく、会話に明示された内容の抽出）：
  - 「2024年に〜」「2026年8月に〜」のように年（および場合により月）が会話の中に明示的に
    書かれている場合は、その値をそのまま採用する。
  - 「9月10日」のように年が明示されていない絶対日付は、会話の文脈から年が明確に特定
    できる場合にのみ採用する。文脈からの安易な補完（「今年だろう」という推測だけ）は
    しない。年が確定できなければeventTimeを設定しない。
- 存在しない時間精度を絶対に作らない。「2024年」から分かるのは年までであり、月・日は
  絶対に作らない。「去年の夏」のように月未満の粒度（季節）しか分からない場合、無理に
  特定の月へ丸めず年精度（precision: "year"）にとどめる。
- 「◯年前」「◯週間前」「先週の日曜日」のような、固定表現5つに含まれない相対的な時間
  表現については、あなた自身で現在の日付から計算してeventTimeを作ってはいけない。
  この場合eventTimeSourceは"none"、eventTime・eventTimePrecisionとも設定しない。
- 「最近」「この前」「昔」「高校の頃」のような曖昧な時間表現、または時間表現が一切
  無い内容については、eventTimeSourceは"none"、eventTime・eventTimePrecisionとも
  設定しない（無理に値を作らない方が正しい）。
- 1つのMemory候補の中に複数の異なる出来事の時間が含まれ、どれが主要な出来事の時間かを
  明確に決められない場合も、eventTimeSourceは"none"、eventTime・eventTimePrecisionとも
  設定しない（例：「昨日さきさんと話して、明日また会う」を1つのMemoryとして扱う場合、
  過去と未来のどちらが中心か安全に決められないため"none"とする）。
- 既存Memoryを更新する場合（existingMemoryIdを設定する場合）でも、eventTimeSource/
  eventTime/eventTimePrecisionは今回のあなたの判定結果として設定してよい（既存の値を
  保持するか上書きするかはCapture処理側が別途判断するため、あなたは今回分かる範囲の
  判定を素直に出力すればよい）。

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
 * Time Axis Phase 2（Event Time, v1）。本日の日付（JST）だけを参考情報として渡す。
 * 「今日/昨日/一昨日/明日/明後日」の実際の日付計算はLLMの役割ではないため
 * （SYSTEM_PROMPT側のEvent Time判定ルール参照）、ここでは相対表現の対応表は渡さない。
 * 本日の日付自体は、「9月10日」のような年省略の絶対日付について、会話の文脈から年が
 * 明確かどうかをLLMが判断する際の参考として使われる。
 */
function buildEventTimeReferenceSection(todayDateString: string): string {
  return `\n\n=== 本日の日付（参考情報。日本時間） ===\n本日の日付は${todayDateString}です。\n=== END 本日の日付 ===`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Time Axis Phase 2（Event Time, v1）。「deterministic resolverを最終決定者にする」設計：
 * LLMが選んだeventTimeSourceが固定語彙5値（today/yesterday/day-before-yesterday/
 * tomorrow/day-after-tomorrow）のいずれかであれば、このCaptureリクエストで確定した
 * 同一のJST基準日（todayDateString）からresolveEventTimeSourceDate()で機械的に解決し
 * 直し、LLM自身が返したeventTime/eventTimePrecisionがあっても無条件で上書きする
 * （値そのものの最終決定権をTsumugi側に置く）。
 *
 * eventTimeSourceが"none"（固定語彙のどれにも対応しないというLLMの判断結果）・無い・
 * 不正な場合は、eventTimeSourceだけを取り除き、LLMが返したeventTime/eventTimePrecision
 * （「2024年に〜」のような明示的な絶対時間の抽出結果）があればそのまま素通しする
 * （precision・実在暦日の検証はcapture.ts側の既存ロジックが引き続き担当する）。
 *
 * eventTimeSource自体は一時的なLLM判定情報でありMemoryObject/Markdownへ永続化しないため、
 * どちらの経路でもレスポンスからは必ず取り除く（クライアント側へ一切渡さない）。
 */
function finalizeEventTimeForMemory(memory: Record<string, unknown>, todayDateString: string): Record<string, unknown> {
  const { eventTimeSource, ...rest } = memory;
  if (isValidEventTimeSource(eventTimeSource) && eventTimeSource !== "none") {
    const resolvedDate = resolveEventTimeSourceDate(todayDateString, eventTimeSource);
    return { ...rest, eventTime: resolvedDate, eventTimePrecision: "day" };
  }
  return rest;
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

/**
 * TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用。
 * 「Function内部の前処理」「Gemini呼び出し」「Gemini後の後処理」の3区間の
 * 所要ミリ秒だけをServer-Timing応答ヘッダとして返す（標準のResponse Timing API・
 * ブラウザのNetworkタブから確認できる）。区間名と数値以外は一切含めない
 * （会話内容・transcript・Memory本文・summary・keyword・prompt本文・APIキー・
 * 個人情報は絶対に含めない）。計測対象はcapture/reflectの2 routeのみ
 * （chat/prompt/connectは今回対象外）。原因調査が終わり次第削除すること。
 */
function buildServerTimingHeader(requestStart: number, geminiCallStart: number, geminiCallEnd: number): string {
  const responseReturn = Date.now();
  const preGemini = geminiCallStart - requestStart;
  const gemini = geminiCallEnd - geminiCallStart;
  const postGemini = responseReturn - geminiCallEnd;
  return `pre-gemini;dur=${preGemini}, gemini;dur=${gemini}, post-gemini;dur=${postGemini}`;
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
          topicDecision: {
            type: "string",
            enum: ["sameTopic", "newTopic", "uncertain"],
            description:
              "existingMemoryIdとは別の軸。既存Memory・関連Memory候補のいずれかと同じ継続的テーマなら" +
              "sameTopic、明確に異なる新しいテーマならnewTopic、どちらとも言えなければuncertain（迷う場合は必ずuncertain）",
          },
          sameTopicMemoryId: {
            type: "string",
            description:
              "topicDecisionがsameTopicの場合のみ、同じテーマだと判断した既存Memory・関連Memory候補のid",
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
          eventTimeSource: {
            type: "string",
            enum: ["today", "yesterday", "day-before-yesterday", "tomorrow", "day-after-tomorrow", "none"],
            description:
              "この記憶の中心的な出来事が「今日・昨日・一昨日・明日・明後日」のいずれかに" +
              "対応するかを必ず判断して設定する（必須）。対応する場合はその表現を設定する" +
              "（日付そのものの計算はTsumugi側が行うため、ここでは表現の選択だけを行う。" +
              "eventTime/eventTimePrecisionは省略してよい）。対応しない・確信が持てない" +
              '場合は"none"を設定する（安全な既定値。少しでも根拠が薄ければ"none"を選ぶこと）',
          },
          eventTime: {
            type: "string",
            description:
              'eventTimeSourceが"none"の場合にのみ使う、それ以外の出来事の時間（分かる範囲でのみ）。' +
              'precisionに応じて"YYYY-MM-DD"（day）・"YYYY-MM"（month）・"YYYY"（year）の' +
              "いずれかの形式。出来事の時間が不明・曖昧な場合は省略する（架空の精度を作らない）",
          },
          eventTimePrecision: {
            type: "string",
            enum: ["day", "month", "year"],
            description: "eventTimeを設定した場合のみ、その値が示す精度",
          },
        },
        required: ["summary", "content", "keywords", "types", "confidence", "topicDecision", "eventTimeSource"],
      },
    },
  },
  required: ["memories"],
};

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("capture");
  // TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用に、
  // Function内部処理／Gemini呼び出し／後処理の3区間だけを計測する。会話内容・
  // transcript・Memory本文・summary・keyword・prompt本文・APIキー・個人情報は
  // 一切含めず、区間ごとの経過ミリ秒だけをServer-Timing応答ヘッダとして返す
  // （buildServerTimingHeader参照）。thinkingBudget・プロンプト・処理順序・
  // ロジック自体は一切変更していない。
  const requestStart = Date.now();
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

  const todayDateString = getJstTodayDateString();
  const transcript = `会話中のペルソナ: ${PERSONA_LABEL[persona] ?? persona}\n\n---\n\n${buildTranscript(turns)}${buildExistingMemoriesSection(existingMemories ?? [])}${buildRelatedMemoriesSection(relatedMemories ?? [])}${buildEventTimeReferenceSection(todayDateString)}`;

  const provider = getProvider(providerName);
  let response: { text: string };
  const geminiCallStart = Date.now();
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
  const geminiCallEnd = Date.now();

  const text = response.text;
  if (!text) {
    return Response.json(
      { error: "AI did not return a structured memory extraction." },
      { status: 502 }
    );
  }

  try {
    const parsed = JSON.parse(text) as { memories?: unknown };
    const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
    const finalizedMemories = memories.map((memory) =>
      isRecord(memory) ? finalizeEventTimeForMemory(memory, todayDateString) : memory
    );
    return Response.json(
      { ...parsed, memories: finalizedMemories },
      { headers: { "Server-Timing": buildServerTimingHeader(requestStart, geminiCallStart, geminiCallEnd) } }
    );
  } catch {
    return Response.json(
      { error: "Failed to parse AI response as JSON." },
      { status: 502 }
    );
  }
}
