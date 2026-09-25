import { PERSON_RELATIONS, type ConversationTurn, type MemoryType, type Persona } from "@/lib/types";
import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import { stripLeadingTimeLabels } from "@/lib/timeLabel";
import { getJstTodayDateString, isValidEventTimeSource, resolveEventTimeSourceDate } from "@/lib/eventTimeResolver";
import { PROFILE_LIMITS, draftsToCandidates, normalizeText, validateProfileCandidates, type ProfileDropReason } from "@/lib/profile";
import { jstDateOf } from "@/lib/dateModel";
import {
  PERSON_MEMORY_LIMITS,
  draftsToPersonMentionCandidates,
  validatePersonMentionCandidates,
  type PersonMentionDropReason,
} from "@/lib/person";
import {
  TOPIC_EVENT_LIMITS,
  draftsToTopicEventQuotes,
  validateTopicEventQuotes,
  type TopicEventDropReason,
} from "@/lib/topicEvent";

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
- Userが明示した内容から、後から再利用できる命題を抽出し保存する
  （会話を自然な文章に書き起こすことが目的ではない。Userの発言の意味そのものを保存する）
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
    Tsumugi側が計算するため、eventTime/eventTimePrecisionは省略してよい。
  - 対応しない、または確信が持てない場合："none"を設定する（安全な既定値。少しでも
    根拠が薄ければ必ず"none"を選ぶ）。
- 【必須・eventTimeSourceが"none"以外の場合のみ】その判断の根拠になった、
  USER'S ACTUAL STATEMENTS中の該当箇所を、短い逐語の引用としてeventTimeQuoteへ
  必ず設定する（15字程度、長くしすぎない。要約・言い換えではなく、実際にユーザーが
  書いた文字列そのものを引用すること）。
  - 実際の日付は、この引用が実際にどのユーザー発言に含まれていたか（その発言の
    実時刻）から、Tsumugi側が機械的に計算する。AI RESPONSESからの引用は無効
    （その場合Event Timeは付与されない）。
  - 引用元にできるのはUSER'S ACTUAL STATEMENTSだけ。AI RESPONSESの中で「今日」
    「昨日」等と述べていても、それを根拠にeventTimeSourceを設定してはいけない
    （その出来事の中心がユーザー自身の発言に無いなら"none"を選ぶ）。
  - eventTimeSourceが"none"の場合はeventTimeQuoteを省略してよい。
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

Memory Evidence Boundary（記憶として保存してよい根拠の境界。最重要。既存Memoryを
UPDATEする場合も、新規Memoryを作る場合も、この境界は同じように適用される）:

Assistant responses are context, not evidence.
AI RESPONSESは、USER'S ACTUAL STATEMENTSの意味・対象を正しく理解するための文脈情報
です。AI RESPONSES自体が新しく述べた内容を、Userについての事実としてMemory化しては
いけません。

- AI RESPONSESを使ってよいのは、次のようにUserの発言の意味を正しく理解するためだけです：
  - 直前の質問が何についてのものだったか（質問対象）
  - 代名詞・指示語が指すもの
  - 省略された主語・目的語
  - 「はい」「そう」「かなり好き」のような短い返答が、何に対する返答か
  - 会話のトピック
- AI RESPONSESで新しく登場した、次のような内容を、それ単独でMemoryへ昇格させては
  いけません：
  - Userの感情・性格・意図・好み・人間関係についての、AI自身の解釈や推測
  - AIによる評価・形容・印象（「落ち着いた雰囲気」「パスタがおいしい」等）
  - AIが述べた外部の事実（店名・サービス名・仕様・人物の役職等）
  - AIが会話中に新しく作った概念・テーマ・理論・比喩・物語的な意味づけ
  - AIの提案・例・アイデア・予定
- Userが、AIの提案・説明・言い換えに対して明示的または文脈上明確に同意・選択・反応
  した場合は、その反応そのもの（Userの発言）を根拠にMemory化してよい。
  例：AI「Obsidianで記録してみるのはどうですか？」User「それいいね」
  　→「Obsidianに関心を示した」はMemory化してよい（根拠はUserの「それいいね」）。
  一方：AI「Obsidianで記録してみるのはどうですか？」User「なるほど」
  　→ UserがObsidianを使っている／関心がある、とは断定しない。
- AIが会話中に新しく作った概念・テーマ・人物像・理論・メソッド・比喩などを、それだけを
  根拠としてUserの過去の関心や価値観として保存してはいけない。
- Userが実際に述べた内容を超えて推測・補完しない。

evidenceQuotes（この記憶を成立させる直接の根拠。必須）:
- 各Memory候補について、その記憶の内容を裏付ける、USER'S ACTUAL STATEMENTSからの
  短い逐語引用（要約や言い換えではなく、実際にUserが書いた文字列そのもの）を1〜4件、
  evidenceQuotesへ設定する。
- evidenceQuotesに含めるquoteは、すべて実際のUser発言に文字通り存在するものだけに
  する。AI RESPONSESにしか存在しない文言・要約・言い換え・実際には無い発言を、
  quoteとして作り出してはいけない。1件でもUser発言に存在しないquoteが含まれていると、
  そのMemory候補は全体としてTsumugi側で破棄される（他のquoteが正しくても救済されない）。
- evidenceQuotesは「このMemoryの根拠になったUser発言」であり、content/summaryは
  それらを引用符のまま連結する必要はない。許可される整理・禁止される追加の具体的な
  境界は次項（content/summaryの境界）の通り。

content/summaryの境界（許可される整理 と 許可されない追加の区別。最重要）:
Memoryは「Userの発言の意味を保存する」ものであり、「Userの発言を解釈して豊かにする」
ものではない。この違いは、AI RESPONSESの語句を使ったかどうかとは無関係に常に適用する
——Capture自身の要約の書きぶりだけで、AI RESPONSESの語句を一切使わなくても意味が
加わってしまう場合も同じくNG。
- 許可：短縮／言い換え／文法的な整形／文脈から明確な指示対象を補う／Assistantの質問を
  利用した、省略された主語・目的語の解決。
- 禁止：心情の追加／因果関係の追加（「〜によって改めて感じた」等）／動機の追加／
  程度の強化（「好き」→「楽しんでいる」等の強調）／対比の追加（「〜だけでなく」等）／
  性格・価値観への一般化／AI RESPONSESが提示した解釈をUserの事実として採用すること。

OK例：AI「運転するのは好きですか？」User「かなり好き。」
　→ evidenceQuotes: ["かなり好き。"]、content:「車を運転するのが好き」→ OK
　　（「運転」という対象はAIの質問を参照して補っただけで、新しい意味は加えていない）

NG例1（AI RESPONSESの語句をそのまま取り込む場合）：
User「運転は好き。」／AI「運転するとリフレッシュになりますよね。」
　→ content「運転がリフレッシュになっている」→ NG（「リフレッシュ」はAI由来）

NG例2（AI RESPONSESの語句を使わず、Capture自身の要約だけで意味が加わる場合）：
User「車で移動したけど、運転は好き。」
　→ summary「車での移動を経験し、改めて運転が好きだと感じた」→ NG（因果・再認識の追加）
　→ content「移動手段としてだけでなく、運転そのものを楽しんでいる」→ NG（対比の追加・強調）
　→ OK：summary「車の運転が好き」／content「車を運転するのが好き。」

keywords:
- keywordsも、Userの発言・検証済みevidenceQuotesが表すトピックに対応する語を優先する。
- AI RESPONSESにしか登場しない、Assistant独自の解釈・言い換えの語をkeywordとして
  追加しない。
  例：User「車で移動した。運転は好き」、AI「家族ドライブですね」の場合、「車」「運転」は
  User発言に直接対応するため良いが、「ドライブ」はAIが使った語であり、User発言に直接
  対応しないなら避ける。

Memoryの文章は、可能な限りUserが実際に話した具体的な内容に基づいて作成する。`;

function buildTranscript(turns: ConversationTurn[]): string {
  const userLines = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content)
    .join("\n");
  // AI発言の先頭に、モデルが出力した入力専用の日時ラベルが保存されていても、Captureの入力へ混ぜない
  // （保存済みのデータ自体は書き換えない。ユーザー発言は変更しない）。
  const aiLines = turns
    .filter((turn) => turn.role !== "user")
    .map((turn) => stripLeadingTimeLabels(turn.content))
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
 * JST日付モデル Phase 2（Event Time, Message Time基準への変更）。
 *
 * `eventTimeQuote`（LLMが返した、USER'S ACTUAL STATEMENTSからの短い逐語引用）を、
 * 実際のUser turnへ決定的に照合し、一致したturnの`timestamp`（Message Time）のJST暦日を
 * 「今日」の基準にする。Capture実行時刻（サーバーがこのリクエストを処理した時刻）は
 * 一切使わない——これにより、日付が変わった後に実行されるstartup catch-up Capture・
 * 遅延Captureでも、実際にユーザーが「今日」と述べた時点を基準に正しく解決できる
 * （Profile v1の`validateProfileCandidates`と同じ「quoteをユーザーturnへ逐語照合する」
 * 決定的な検証パターンを再利用する。`normalizeText`はprofile.tsからそのままimportし、
 * Profile側のロジック・挙動は一切変更しない）。
 *
 * fail-closed：以下のいずれかに該当する場合、Event Timeは付与しない
 * （Capture実行日など、もっともらしい値へのfallbackは行わない）。
 * - eventTimeQuoteが無い・空・文字列でない
 * - USER turnのどれにも一致しない（AI turnにしか無い場合を含む。Conversation Evidence
 *   Boundaryと同じ原則——Assistant/Tsumugi発言の「今日」「昨日」「明日」を根拠にしない）
 * - 一致したUser turnが複数あり、かつそれらのMessage TimeのJST暦日が割れる場合
 *   （日を跨いで同じ短い言い回しが複数回登場したケース。安全側で推測しない）
 * - 一致したUser turnに有効なtimestampが1件も無い場合
 *
 * それ以外（一致が1件、または複数だが全て同じJST暦日）は、その暦日から
 * `resolveEventTimeSourceDate()`で機械的に日付を計算する（この関数自体の実装は
 * 「基準日文字列＋固定語彙→日付」という既存のまま変更しない。Tsumugi側が最終決定者、
 * という既存原則も維持する）。
 *
 * eventTimeSourceが"none"（固定語彙のどれにも対応しないというLLMの判断結果）・無い・
 * 不正な場合は、eventTimeSource/eventTimeQuoteだけを取り除き、LLMが返したeventTime/
 * eventTimePrecision（「2024年に〜」のような明示的な絶対時間の抽出結果）があれば
 * そのまま素通しする（precision・実在暦日の検証はcapture.ts側の既存ロジックが
 * 引き続き担当する。この経路はMessage Time基準化の対象外——「今日/昨日」等の相対表現
 * ではなく、会話に明示された絶対時間の抽出結果のため）。
 *
 * eventTimeSource/eventTimeQuoteはいずれも一時的なLLM判定情報でありMemoryObject/
 * Markdownへ永続化しないため、どの経路でもレスポンスからは必ず取り除く
 * （クライアント側へ一切渡さない）。
 */
function resolveEventTimeQuoteBasisJstDate(turns: ConversationTurn[], rawQuote: unknown): string | null {
  const quote = typeof rawQuote === "string" ? rawQuote.trim() : "";
  if (!quote) return null;
  const nq = normalizeText(quote);
  if (!nq) return null;

  const userTurns = turns.filter((turn) => turn.role === "user");
  const matchedUserTurns = userTurns.filter((turn) => normalizeText(turn.content).includes(nq));
  if (matchedUserTurns.length === 0) return null; // AI発言にしか無い、または存在しない（fail-closed）

  const jstDates = new Set<string>();
  for (const turn of matchedUserTurns) {
    const d = jstDateOf(turn.timestamp);
    if (d) jstDates.add(d);
  }
  if (jstDates.size !== 1) return null; // timestampが1件も有効でない、または複数の異なるJST日に割れる

  return [...jstDates][0];
}

function finalizeEventTimeForMemory(memory: Record<string, unknown>, turns: ConversationTurn[]): Record<string, unknown> {
  const { eventTimeSource, eventTimeQuote, ...rest } = memory;
  if (isValidEventTimeSource(eventTimeSource) && eventTimeSource !== "none") {
    const basisJstDate = resolveEventTimeQuoteBasisJstDate(turns, eventTimeQuote);
    if (basisJstDate) {
      const resolvedDate = resolveEventTimeSourceDate(basisJstDate, eventTimeSource);
      return { ...rest, eventTime: resolvedDate, eventTimePrecision: "day" };
    }
    return rest; // 根拠を検証できない → Event Timeを推測せず付けない（fail-closed）
  }
  return rest;
}

/**
 * 観測性のみの追加（2026-09-23）。dropの理由をログ集計するためだけの列挙値。
 * validation自体のロジック・判定結果には一切影響しない（既存のboolean判定をそのまま
 * 維持し、その判定に至った理由をラベル付けするだけ）。値そのものにUser/Assistant発言・
 * quote本文は一切含まない（列挙値のみ）。
 */
type EvidenceDropReason = "missing" | "invalid-count" | "invalid-type" | "empty-quote" | "not-found";

/**
 * Capture Evidence Boundary（Memory本体、2026-09-23）。「このMemory候補を成立させる根拠」
 * としてLLM自身が提出した`evidenceQuotes`を、実際のUser turnへ決定的に照合する。
 * Profile v1の`quote`検証（profile.ts `validateProfileCandidates`）・Event Time Phase 2の
 * `eventTimeQuote`検証（`resolveEventTimeQuoteBasisJstDate`、本ファイル）と同じ
 * 「normalizeTextで正規化してからexact substring match、User turnのみを証拠として認める」
 * パターンを再利用する（`normalizeText`はprofile.tsから読み取り専用でimportするだけで、
 * Profile自体のロジック・挙動は一切変更しない）。
 *
 * fail-closed（Event Time・Profileより厳しい）：evidenceQuotesのうち1件でも実際のUser turn
 * に存在しなければ、そのMemory候補**全体**を破棄する。他の有効なquoteがあっても部分的に
 * 救済しない——「この記憶の根拠」としてLLMが自ら提出した集合の中にAI由来・捏造のquoteが
 * 1件でも混ざっている時点で、そのMemory候補の生成過程自体を信頼できないと判断するため
 * （承認済み設計：evidenceQuotesは全件validでなければMemory候補ごと破棄）。
 *
 * 条件：
 * - `evidenceQuotes`は配列で、要素数が1〜4件であること
 * - 各要素は空でない文字列であること
 * - 各要素は、normalizeText後、USER turn（role: "user"）のいずれかのcontentに
 *   normalizeText後の状態で部分一致（exact substring）すること。AI turn（role: "ai"）
 *   にしか存在しない・どこにも存在しない場合は無効
 * 1つでも上記を満たさない要素があれば、この関数はvalid:falseを返す（呼び出し元が
 * Memory候補全体を破棄する。判定ロジック自体は観測性追加の前後で一切変更していない）。
 *
 * 観測性のみの追加：戻り値を`boolean`から`{valid, reason?}`へ変更した。`valid`の
 * 計算式・分岐条件・判定順序は変更前と完全に同一で、各`return false`の位置に、その
 * 場所を表す`reason`ラベルを付けただけ（新しい判定条件は追加していない）。
 */
function validateMemoryEvidenceQuotes(
  turns: ConversationTurn[],
  rawEvidenceQuotes: unknown
): { valid: boolean; reason?: EvidenceDropReason } {
  if (!Array.isArray(rawEvidenceQuotes)) return { valid: false, reason: "missing" };
  if (rawEvidenceQuotes.length < 1 || rawEvidenceQuotes.length > 4) return { valid: false, reason: "invalid-count" };
  const userTurns = turns.filter((turn) => turn.role === "user");
  for (const rawQuote of rawEvidenceQuotes) {
    if (typeof rawQuote !== "string") return { valid: false, reason: "invalid-type" };
    const quote = rawQuote.trim();
    if (!quote) return { valid: false, reason: "empty-quote" };
    const nq = normalizeText(quote);
    if (!nq) return { valid: false, reason: "empty-quote" };
    const existsInUserTurn = userTurns.some((turn) => normalizeText(turn.content).includes(nq));
    if (!existsInUserTurn) return { valid: false, reason: "not-found" };
  }
  return { valid: true };
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

const MEMORIES_SCHEMA_BASE: AISchema = {
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
          evidenceQuotes: {
            type: "array",
            items: { type: "string" },
            description:
              "この記憶を成立させる直接の根拠（必須）。USER'S ACTUAL STATEMENTSからの短い逐語" +
              "引用を1〜4件。要約・言い換えではなく実際にUserが書いた文字列そのものを引用する。" +
              "AI RESPONSESからの引用・存在しない発言の捏造は不可——1件でも実際のUser発言に" +
              "存在しないquoteが含まれていると、この記憶候補は全体として破棄される",
          },
          summary: {
            type: "string",
            description:
              "User evidenceから取り出した中心命題を、短く直接的に表現する（20〜40文字程度が" +
              "目安。命題がそれより短ければ、文字数を満たすために情報を付け足さず、短いままでよい）。" +
              "ユーザー自身が明示した事実・感情・意図・好みは含めてよいが、AIが推測・解釈した" +
              "感情・性格・意図・好み・関係性を追加してはいけない（evidenceQuotesの意味の範囲を超えない）",
          },
          content: {
            type: "string",
            description:
              "そのMemoryを成立させるevidenceの意味だけを書く。長さはevidenceが持つ情報量で決まり、" +
              "evidenceが短ければcontentも短くてよい（summaryとほぼ同じ内容・長さになっても" +
              "問題ない）。背景・因果・情緒・説明を補って文章を膨らませない。ユーザー自身が明示した" +
              "事実・感情・意図・好みは含めてよいが、AIが推測・解釈した感情・性格・意図・好み・" +
              "関係性を追加してはいけない（evidenceQuotesの意味の範囲を超えない。paraphrase・" +
              "主語補完・代名詞解決は可）",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description:
              "検索やリンクの手がかりになるキーワード（3〜8個）。Userの発言・evidenceQuotesが" +
              "表すトピックに対応する語を優先し、AI RESPONSESにしか登場しないAssistant独自の" +
              "解釈語は避ける",
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
          eventTimeQuote: {
            type: "string",
            description:
              'eventTimeSourceが"none"以外の場合のみ設定する（必須）。その判断の根拠になった、' +
              "USER'S ACTUAL STATEMENTS中の該当箇所の短い逐語引用（15字程度）。実際の日付は、" +
              "この引用が実際にどのユーザー発言に含まれていたかから機械的に計算するため、" +
              "要約や言い換えではなく実際の文字列をそのまま引用すること。AI RESPONSESからの" +
              "引用は無効（Event Timeが付与されない）。eventTimeSourceが\"none\"の場合は省略する",
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
        required: ["evidenceQuotes", "summary", "content", "keywords", "types", "confidence", "topicDecision", "eventTimeSource"],
      },
    },
  },
  required: ["memories"],
};

/**
 * Personal Profile v1（optional出力）。既存のCapture呼び出しに、Profile候補（profileClaims）を任意で出させる。
 * 既存のMemory抽出（件数・NEW/UPDATE・topicDecision・summary/content・Event Time）を悪化させないことが最優先のため、
 * 無い会話では出力しない（0件が正常）。環境変数`PROFILE_CLAIMS_ENABLED=false`（または0）で、プロンプト・schema・
 * 出力の全てを従来と同一に戻せる（品質が悪化した場合のキルスイッチ）。
 */
function profileClaimsEnabled(): boolean {
  const v = (process.env.PROFILE_CLAIMS_ENABLED ?? "").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

const PROFILE_PROMPT_SECTION = `

Profile候補（任意。ほとんどの会話では出力しない。0件が正常）:
- Memory候補ごとに、ユーザー本人の「安定した前提」がUSER'S ACTUAL STATEMENTSに明示されている場合だけ、
  profileClaimsに候補を入れてよい。無い会話（雑談・質問・一時的な相談など）では省略する。無理に作らない。
- 出してよいcategoryはこの6つだけ。residence（居住地域。市区町村まで。詳細な住所は不可）／
  occupation（職業・勤務先）／household（家族構成上の「存在」の事実だけ。配偶者・パートナー、子ども、親、
  兄弟姉妹、ペット。関係の良し悪し・感情・価値観は不可）／project（継続的な取り組み）／goal（長期的な目標）／
  preference（本人が明確に述べた好み）。
- 根拠はユーザー本人の発言だけ。quoteはUSER'S ACTUAL STATEMENTSからの逐語の抜粋（80字以内）。AIの発言・提案・
  要約・形容は根拠にしない。ユーザー以外の人の話、仮定・冗談・創作・伝聞・迷い（「〜かも」「〜しようかな」）は出さない。
- 推測しない。性格・価値観・感情・恐れ・大切にしていること・人物像（例：「家族を大切にしている」「〜がつらい」
  「家庭を壊したくない」）は出さない。健康・宗教・性的指向・政治・お金の詳細・家庭の事情などの機微な情報も出さない。
  迷ったら出さない。
- statementは時間に依存しない短い言明（例：「千葉に住んでいる」）。「今」「最近」「来月」などの相対的な時間語は含めない。
- tense: current（今そうである）／former（以前はそうだった）／planned（予定・決まっている未来）。
  change: none／began（「〜した・〜になった」と変化の完了を述べている）／ended（「〜をやめた・辞めた」と終了を述べている）。
  stated は常に "explicit"。
- residence・occupationにはvalueに短い値（例：「千葉」「A社 営業」）。householdにはrelation
  （partner/child/parent/sibling/pet/other）。project・goal・preferenceにはkey（短い名詞句）。
- validFromSource（今日・昨日・一昨日・明日・明後日）または validFrom+validFromPrecision（会話に明示された年月日のみ）は、
  その変化・予定の時期が会話に明示されている場合だけ。分からなければ省略する。
- 既存Memoryを更新する場合でも、今回の会話で新しく明示された前提だけを出す。この判断は、上のMemory抽出の判断
  （粒度・existingMemoryId・topicDecision・Event Time）に影響させない。`;

const PROFILE_CLAIMS_ITEM_SCHEMA: AISchema = {
  type: "array",
  description:
    "任意。ユーザー本人が明示した安定した前提（居住・職業・家族構成・継続的な取り組み・長期的な目標・明確な好み）の候補。" +
    "無い会話では省略する（0件が正常）。推測・感情・価値観・機微な情報は出さない",
  items: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["residence", "occupation", "household", "project", "goal", "preference"] },
      key: { type: "string", description: "project・goal・preferenceの短い名詞句（householdでrelationがotherの場合も）" },
      relation: { type: "string", enum: ["partner", "child", "parent", "sibling", "pet", "other"], description: "householdのみ" },
      value: { type: "string", description: "residence・occupationの短い値（例：千葉／A社 営業）" },
      statement: { type: "string", description: "時間に依存しない短い言明（60字以内）" },
      tense: { type: "string", enum: ["current", "former", "planned"] },
      change: { type: "string", enum: ["none", "began", "ended"] },
      stated: { type: "string", enum: ["explicit"], description: "常にexplicit（ユーザーが明示した内容のみ）" },
      quote: { type: "string", description: "USER'S ACTUAL STATEMENTSからの逐語の抜粋（80字以内）" },
      validFromSource: {
        type: "string",
        enum: ["today", "yesterday", "day-before-yesterday", "tomorrow", "day-after-tomorrow"],
        description: "変化・予定の時期が今日・昨日等で明示されている場合のみ",
      },
      validFrom: { type: "string", description: "会話に明示された年月日のみ（YYYY-MM-DD / YYYY-MM / YYYY）" },
      validFromPrecision: { type: "string", enum: ["day", "month", "year"] },
      confidence: { type: "number" },
    },
    required: ["category", "statement", "tense", "change", "stated", "quote"],
  },
};

/**
 * Person Memory v1（optional出力）。既存のCapture呼び出しに、第三者への言及候補
 * （personMentions）を任意で出させる。Personal Profile（ユーザー本人）とは明確に別軸
 * ——ここで扱うのは会話に登場する第三者だけ。既存のMemory抽出・Profileを悪化させない
 * ことが最優先のため、無い会話では出力しない（0件が正常）。環境変数
 * `PERSON_MEMORY_ENABLED=false`（または0）で、プロンプト・schema・出力の全てを
 * 従来と同一に戻せる（品質が悪化した場合のキルスイッチ、Profileと同じ仕組み）。
 */
function personMemoryEnabled(): boolean {
  const v = (process.env.PERSON_MEMORY_ENABLED ?? "").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

const PERSON_MENTIONS_PROMPT_SECTION = `

Person Mentions候補（任意。ほとんどの会話では出力しない。0件が正常）:
- Memory候補ごとに、Userが名前または明示的な呼称（「さきさん」「妻」「長男」「上司」等）で
  特定した第三者について、personMentionsに候補を入れてよい。無ければ省略する。
- displayNameはUserが実際に使った呼び方をそのまま使う（言い換えない）。relationは
  分かる範囲でのみ設定する（現状のカテゴリのみ。性格・感情・関係の良し悪しは含めない）。
- 根拠はUser本人の発言だけ。quoteはUSER'S ACTUAL STATEMENTSからの逐語の抜粋。
  AIの発言だけを根拠に人物の存在・relationを作らない。
- Userが、既存のrelationを明示的に否定・訂正する発言をした場合（例：「さきさんは
  友人じゃなくて同僚だよ」）だけ、correctionへ{invalidatesRelation, replacementRelation}
  （置き換えが無い場合はinvalidatesRelationのみ）を設定してよい。訂正かどうか迷う場合、
  または単に状況が変わっただけ（「以前は同僚だったけど、今は別の会社にいる」）の場合は
  correctionを付けない（最終的な適用可否はTsumugi側が決定的に検証する）。`;

const PERSON_MENTION_ITEM_SCHEMA: AISchema = {
  type: "array",
  description:
    "任意。Userが名前または明示的な呼称で特定した第三者への言及の候補。" +
    "無い会話では省略する（0件が正常）。推測・性格・感情・関係の良し悪しは出さない",
  items: {
    type: "object",
    properties: {
      displayName: { type: "string", description: "Userが実際に使った呼び方（例：さきさん／妻／長男／上司）" },
      relation: { type: "string", enum: [...PERSON_RELATIONS], description: "Userとの関係。分かる範囲でのみ" },
      quote: { type: "string", description: "USER'S ACTUAL STATEMENTSからの逐語の抜粋" },
      correction: {
        type: "object",
        description: "Userが既存のrelationを明示的に否定・訂正した場合のみ設定する",
        properties: {
          invalidatesRelation: { type: "string", enum: [...PERSON_RELATIONS], description: "Userが明示的に否定したrelation" },
          replacementRelation: { type: "string", enum: [...PERSON_RELATIONS], description: "置き換え後のrelation（無い場合は省略）" },
        },
        required: ["invalidatesRelation"],
      },
    },
    required: ["displayName", "quote"],
  },
};

/**
 * Topic / Current State v1（optional出力）。既存のCapture呼び出しに、既存の継続的テーマ
 * （topicId）についての出来事・状態のgrounded evidence候補（topicEvents）を任意で出させる。
 * Person Memoryとは明確に別軸——ここで扱うのはUser逐語の`quote`だけで、AI生成の要約・
 * statement・relationのような構造化解釈は一切持たない（topicEvent.ts参照）。既存の
 * Memory抽出・Profile・Person Memoryを悪化させないことが最優先のため、無い会話では
 * 出力しない（0件が正常）。環境変数`TOPIC_STATE_ENABLED=false`（または0）で、
 * プロンプト・schema・出力の全てを従来と同一に戻せる（品質が悪化した場合のキル
 * スイッチ、Profile/Person Memoryと同じ仕組み）。
 */
function topicStateEnabled(): boolean {
  const v = (process.env.TOPIC_STATE_ENABLED ?? "").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

const TOPIC_EVENTS_PROMPT_SECTION = `

Topic Events候補（任意。ほとんどの会話では出力しない。0件が正常）:
- Memory候補が、既存の継続的なテーマ（topicDecisionがsameTopicまたはnewTopicの場合）
  について、Userが具体的な出来事・状態を述べている場合だけ、topicEventsに、その根拠
  となるUSER'S ACTUAL STATEMENTSからの逐語の抜粋を、文字列としてそのまま入れてよい。
  要約・言い換え・解釈は一切含めない（quoteそのもの以外、何も追加しない）。
- 根拠はUser本人の発言だけ。AIの発言だけを根拠にしない。関係の良し悪し・感情・
  因果関係の推測は書かない。topicDecisionがuncertainの場合は出さない。`;

const TOPIC_EVENT_ITEM_SCHEMA: AISchema = {
  type: "array",
  description:
    "任意。既存の継続的テーマについてUserが述べた具体的な出来事・状態の、USER'S ACTUAL " +
    "STATEMENTSからの逐語の抜粋のみ（要約・解釈は不可）。無い会話では省略する（0件が正常）",
  items: { type: "string", description: "USER'S ACTUAL STATEMENTSからの逐語の抜粋" },
};

function buildMemoriesSchema(includeProfile: boolean, includePersonMemory: boolean, includeTopicEvents: boolean): AISchema {
  if (!includeProfile && !includePersonMemory && !includeTopicEvents) return MEMORIES_SCHEMA_BASE;
  const clone = JSON.parse(JSON.stringify(MEMORIES_SCHEMA_BASE)) as {
    properties: { memories: { items: { properties: Record<string, unknown> } } };
  };
  if (includeProfile) clone.properties.memories.items.properties.profileClaims = PROFILE_CLAIMS_ITEM_SCHEMA;
  if (includePersonMemory) clone.properties.memories.items.properties.personMentions = PERSON_MENTION_ITEM_SCHEMA;
  if (includeTopicEvents) clone.properties.memories.items.properties.topicEvents = TOPIC_EVENT_ITEM_SCHEMA;
  return clone as unknown as AISchema;
}

/**
 * Profile候補を、決定的に検証する（LLMの出力は候補にすぎない）。クライアントは同じ検証を再度行う。
 * 検証を通らなかった候補だけを破棄し、Memory自体には影響しない。破棄の内訳は、件数のみを返す（内容は含めない）。
 */
function finalizeProfileClaimsForMemory(
  memory: Record<string, unknown>,
  turns: ConversationTurn[],
  todayDateString: string,
  budget: { remaining: number },
  stats: { proposed: number; accepted: number; dropped: Partial<Record<ProfileDropReason, number>> }
): Record<string, unknown> {
  const { profileClaims, ...rest } = memory;
  if (profileClaims === undefined) return rest;
  const result = validateProfileCandidates(profileClaims, {
    turns,
    todayJst: todayDateString,
    maxItems: Math.min(PROFILE_LIMITS.perMemoryItem, Math.max(0, budget.remaining)),
    fallbackStatedAt: turns.find((turn) => turn.role === "user" && !Number.isNaN(Date.parse(turn.timestamp)))?.timestamp,
  });
  stats.proposed += result.proposed;
  stats.accepted += result.drafts.length;
  for (const [reason, count] of Object.entries(result.dropped)) {
    stats.dropped[reason as ProfileDropReason] = (stats.dropped[reason as ProfileDropReason] ?? 0) + (count ?? 0);
  }
  budget.remaining -= result.drafts.length;
  return result.drafts.length > 0 ? { ...rest, profileClaims: draftsToCandidates(result.drafts) } : rest;
}

/**
 * Person Mentions候補を、決定的に検証する（LLMの出力は候補にすぎない）。クライアントは
 * 同じ検証を再度行う。検証を通らなかった候補だけを破棄し、Memory自体には影響しない。
 * Correction（既存relationの明示的な否定・訂正）の成立可否も、ここで呼ぶ
 * `validatePersonMentionCandidates`がquote本文への決定的な検証で確定する
 * （LLMの自己申告だけでは成立しない。person.ts参照）。破棄の内訳は件数のみを返す。
 */
function finalizePersonMentionsForMemory(
  memory: Record<string, unknown>,
  turns: ConversationTurn[],
  budget: { remaining: number },
  stats: { proposed: number; accepted: number; dropped: Partial<Record<PersonMentionDropReason, number>>; relationStripped: number }
): Record<string, unknown> {
  const { personMentions, ...rest } = memory;
  if (personMentions === undefined) return rest;
  const result = validatePersonMentionCandidates(personMentions, {
    turns,
    maxItems: Math.min(PERSON_MEMORY_LIMITS.perMemoryItem, Math.max(0, budget.remaining)),
    fallbackStatedAt: turns.find((turn) => turn.role === "user" && !Number.isNaN(Date.parse(turn.timestamp)))?.timestamp,
  });
  stats.proposed += result.proposed;
  stats.accepted += result.drafts.length;
  for (const [reason, count] of Object.entries(result.dropped)) {
    stats.dropped[reason as PersonMentionDropReason] = (stats.dropped[reason as PersonMentionDropReason] ?? 0) + (count ?? 0);
  }
  stats.relationStripped += result.relationStripped;
  budget.remaining -= result.drafts.length;
  return result.drafts.length > 0 ? { ...rest, personMentions: draftsToPersonMentionCandidates(result.drafts) } : rest;
}

/**
 * Topic Events候補を、決定的に検証する（LLMの出力は候補にすぎない）。クライアントは
 * 同じ検証を再度行う。quoteのUser turn逐語一致だけを見る（PersonMentionのような
 * relation・correctionは無い）。検証を通らなかった候補だけを破棄し、Memory自体には
 * 影響しない。破棄の内訳は件数のみを返す。topicIdそのものの決定（`resolvedTopicId`
 * が存在するかのゲート）はここでは行わない——サーバーはtopicIdの実際の値を持たない
 * ため、これはクライアント（capture.ts）の責務。
 */
function finalizeTopicEventsForMemory(
  memory: Record<string, unknown>,
  turns: ConversationTurn[],
  budget: { remaining: number },
  stats: { proposed: number; accepted: number; dropped: Partial<Record<TopicEventDropReason, number>> }
): Record<string, unknown> {
  const { topicEvents, ...rest } = memory;
  if (topicEvents === undefined) return rest;
  const result = validateTopicEventQuotes(topicEvents, {
    turns,
    maxItems: Math.min(TOPIC_EVENT_LIMITS.perMemoryItem, Math.max(0, budget.remaining)),
    fallbackStatedAt: turns.find((turn) => turn.role === "user" && !Number.isNaN(Date.parse(turn.timestamp)))?.timestamp,
  });
  stats.proposed += result.proposed;
  stats.accepted += result.drafts.length;
  for (const [reason, count] of Object.entries(result.dropped)) {
    stats.dropped[reason as TopicEventDropReason] = (stats.dropped[reason as TopicEventDropReason] ?? 0) + (count ?? 0);
  }
  budget.remaining -= result.drafts.length;
  return result.drafts.length > 0 ? { ...rest, topicEvents: draftsToTopicEventQuotes(result.drafts) } : rest;
}

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("capture");
  // TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用に、
  // Function内部処理／Gemini呼び出し／後処理の3区間だけを計測する。会話内容・
  // transcript・Memory本文・summary・keyword・prompt本文・APIキー・個人情報は
  // 一切含めず、区間ごとの経過ミリ秒だけをServer-Timing応答ヘッダとして返す
  // （buildServerTimingHeader参照）。thinkingBudget・プロンプト・処理順序・
  // ロジック自体は一切変更していない。
  const requestStart = Date.now();
  const resolvedApiKey = resolveApiKey(request, providerName);
  if (!resolvedApiKey) {
    return Response.json(
      { error: "Gemini APIキーが設定されていません。" },
      { status: 401 }
    );
  }
  // attemptExtraction()（下のクロージャ）で使うため、undefinedを含まない型として確定させる。
  const apiKey: string = resolvedApiKey;

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
  const profileEnabled = profileClaimsEnabled();
  const personEnabled = personMemoryEnabled();
  const topicEnabled = topicStateEnabled();

  const systemInstruction =
    SYSTEM_PROMPT +
    (profileEnabled ? PROFILE_PROMPT_SECTION : "") +
    (personEnabled ? PERSON_MENTIONS_PROMPT_SECTION : "") +
    (topicEnabled ? TOPIC_EVENTS_PROMPT_SECTION : "");
  const schema = buildMemoriesSchema(profileEnabled, personEnabled, topicEnabled);

  /**
   * Capture Evidence Boundary false negative対策（2026-09-25）：1回のgenerateStructured呼び出し
   * ＋JSON.parse＋evidenceQuotes検証を1セットにまとめただけのヘルパー。判定ロジック
   * （validateMemoryEvidenceQuotes）自体は一切変更していない——単に「同じ厳格な検証を
   * 独立したattemptとして複数回試せるようにする」ための抽出であり、Evidence Boundaryを
   * 弱めるものではない。
   */
  async function attemptExtraction(): Promise<
    | {
        ok: true;
        parsed: { memories?: unknown };
        memoriesRaw: unknown[];
        memories: unknown[];
        evidenceDroppedCount: number;
        evidenceDropReasons: Partial<Record<EvidenceDropReason, number>>;
        geminiCallStart: number;
        geminiCallEnd: number;
      }
    | { ok: false; errorResponse: Response }
  > {
    const attemptStart = Date.now();
    let response: { text: string };
    try {
      response = await provider.generateStructured({
        model: resolveModel(providerName),
        apiKey,
        systemInstruction,
        userContent: transcript,
        providerOptions: { gemini: { thinkingBudget: computeThinkingBudget(transcript) } },
        schema,
      });
    } catch (error) {
      console.error("[Tsumugi Capture] generateContent failed:", error);
      return {
        ok: false,
        errorResponse: Response.json({ error: "Failed to generate a memory extraction from the AI model." }, { status: 502 }),
      };
    }
    const attemptEnd = Date.now();

    const text = response.text;
    if (!text) {
      return {
        ok: false,
        errorResponse: Response.json({ error: "AI did not return a structured memory extraction." }, { status: 502 }),
      };
    }

    let parsed: { memories?: unknown };
    try {
      parsed = JSON.parse(text) as { memories?: unknown };
    } catch {
      return { ok: false, errorResponse: Response.json({ error: "Failed to parse AI response as JSON." }, { status: 502 }) };
    }
    const memoriesRaw = Array.isArray(parsed.memories) ? parsed.memories : [];

    // Capture Evidence Boundary（Memory本体）：evidenceQuotesの全件検証をパイプラインの
    // 最初（Event Time/Profileの検証より前）で行う。型不正（isRecordでない）要素は、
    // このゲートの対象外として従来通り後続へ素通りさせる（isRecordチェック自体は
    // 既存のfinalizeEventTimeForMemory呼び出し前のガードで担っており、ここでの責務は
    // 「evidenceQuotesを持つMemory候補の根拠検証」だけに限定する）。
    // 観測性のみの追加：dropReasonsは件数集計のためだけに保持する（内容は一切含まない）。
    // filterの採否判定（`result.valid`）自体は観測性追加の前後で完全に同一。
    let evidenceDroppedCount = 0;
    const evidenceDropReasons: Partial<Record<EvidenceDropReason, number>> = {};
    const memories = memoriesRaw.filter((memory) => {
      if (!isRecord(memory)) return true;
      const result = validateMemoryEvidenceQuotes(turns, memory.evidenceQuotes);
      if (!result.valid) {
        evidenceDroppedCount += 1;
        if (result.reason) evidenceDropReasons[result.reason] = (evidenceDropReasons[result.reason] ?? 0) + 1;
      }
      return result.valid;
    });

    return { ok: true, parsed, memoriesRaw, memories, evidenceDroppedCount, evidenceDropReasons, geminiCallStart: attemptStart, geminiCallEnd: attemptEnd };
  }

  const first = await attemptExtraction();
  if (!first.ok) return first.errorResponse;

  /**
   * Capture Evidence Boundary false negative対策（2026-09-25、実データ検証済み：
   * 同一の長い実Conversationを8回Captureしたところ、8/8回でLLMがMemory候補を提案した
   * にもかかわらず、1/8回でevidenceQuotesの逐語一致失敗により候補が全件dropし、
   * 正当なMemoryが丸ごと失われることを確認した）。
   *
   * 対処は「evidenceQuotes検証を緩める」のではなく、「同じ厳格な検証にもう一度だけ
   * 独立したattemptで挑戦させる」こと——retry後も同一のvalidateMemoryEvidenceQuotes()を
   * 一切変更せず通過したものだけを採用する。部分的に検証を通過したquoteだけで
   * summary/contentを書き換えるような救済（未検証の因果・感情・関係を含んだまま
   * 一部だけ承認する等）は行わない：各attemptは常に「そのattemptのMemory候補全体が
   * 検証を通過したか」で判定し、通過しなかったattemptの結果は使わない。
   *
   * 発火条件を「proposed>0 かつ accepted=0 かつ dropReasonsにnot-foundを含む」に限定する
   * 理由：(1) 実際に確認された故障モード（提案はされたが逐語検証だけで全滅）に対処を
   * 絞るため。(2) 既に1件以上acceptedがある場合はretryしない——複数Memory候補の一部だけ
   * retryすると、retry結果との対応関係が取れず「同じ話題のMemoryが重複する／元のacceptedの
   * 内容が意図せず variant違いに置き換わる」リスクが生じるため、あえて対象外とする
   * （このケースは今回のスコープ外として次回以降の課題とする）。(3) not-found以外の
   * dropReason（invalid-count/invalid-type/empty-quote等）はLLMの出力形式自体が
   * 不正なケースであり、確率的なquote言い回しの揺らぎとは性質が異なるため、単純retryで
   * 改善する根拠が無く対象外とする。retryは最大1回のみ（無限retry禁止）。
   */
  const shouldRetry =
    first.memoriesRaw.length > 0 && first.memories.length === 0 && (first.evidenceDropReasons["not-found"] ?? 0) > 0;

  let finalResult = first;
  let retryAttempted = false;
  let retryRecovered = false;
  if (shouldRetry) {
    retryAttempted = true;
    const retry = await attemptExtraction();
    // retry自体がAPIエラー・空応答・JSON parse失敗になった場合は、retryが役に立たなかった
    // だけとして扱い、1回目の結果（0件）をそのまま使う。retryの失敗を新たなエラー応答には
    // しない（1回目が既に正常応答である以上、リクエスト全体としては成功のまま）。
    if (retry.ok && retry.memories.length > 0) {
      finalResult = retry;
      retryRecovered = true;
    }
  }
  const { parsed, memoriesRaw, memories, evidenceDroppedCount, evidenceDropReasons, geminiCallStart, geminiCallEnd } = finalResult;

  try {
    const profileBudget = { remaining: PROFILE_LIMITS.perCapture };
    const profileStats = { proposed: 0, accepted: 0, dropped: {} as Partial<Record<ProfileDropReason, number>> };
    const personBudget = { remaining: PERSON_MEMORY_LIMITS.perCapture };
    const personStats = { proposed: 0, accepted: 0, dropped: {} as Partial<Record<PersonMentionDropReason, number>>, relationStripped: 0 };
    const topicBudget = { remaining: TOPIC_EVENT_LIMITS.perCapture };
    const topicStats = { proposed: 0, accepted: 0, dropped: {} as Partial<Record<TopicEventDropReason, number>> };
    const finalizedMemories = memories.map((memory) => {
      if (!isRecord(memory)) return memory;
      // evidenceQuotesは一時的なLLM判定情報であり、eventTimeSource/eventTimeQuoteと同じく
      // MemoryObject/Markdownへ永続化しないため、検証後は必ず取り除く
      // （クライアント側へ一切渡さない）。
      const { evidenceQuotes: _evidenceQuotes, ...groundedMemory } = memory;
      void _evidenceQuotes;
      const withEventTime = finalizeEventTimeForMemory(groundedMemory, turns);

      let withTopic: Record<string, unknown>;
      if (topicEnabled) {
        withTopic = finalizeTopicEventsForMemory(withEventTime, turns, topicBudget, topicStats);
      } else {
        // 無効時は、topicEventsを一切返さない（従来と同一の出力）
        const { topicEvents: _ignoredTopic, ...rest } = withEventTime;
        void _ignoredTopic;
        withTopic = rest;
      }

      let withPerson: Record<string, unknown>;
      if (personEnabled) {
        withPerson = finalizePersonMentionsForMemory(withTopic, turns, personBudget, personStats);
      } else {
        // 無効時は、personMentionsを一切返さない（従来と同一の出力）
        const { personMentions: _ignoredPerson, ...rest } = withTopic;
        void _ignoredPerson;
        withPerson = rest;
      }

      if (!profileEnabled) {
        // 無効時は、profileClaimsを一切返さない（従来と同一の出力）
        const { profileClaims: _ignored, ...rest } = withPerson;
        void _ignored;
        return rest;
      }
      return finalizeProfileClaimsForMemory(withPerson, turns, todayDateString, profileBudget, profileStats);
    });
    const headers: Record<string, string> = { "Server-Timing": buildServerTimingHeader(requestStart, geminiCallStart, geminiCallEnd) };
    // 品質の観測用（件数・理由の列挙値のみ。会話・Memory本文・quoteの内容は含めない）。
    // dropReasonsは"reason:count"をカンマ区切りで並べるだけ（0件の理由キーは出力しない）。
    const dropReasonsPart = Object.entries(evidenceDropReasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(",");
    headers["X-Tsumugi-Evidence"] =
      `proposed=${memoriesRaw.length};accepted=${memories.length};dropped=${evidenceDroppedCount}` +
      (dropReasonsPart ? `;dropReasons=${dropReasonsPart}` : "");
    // 観測性のみ（2026-09-25）：not-found全滅時のretryが実際に発火したか・救済できたかを
    // ログから判別できるようにする。retryの判定条件・validateMemoryEvidenceQuotes自体には
    // 一切影響しない。
    if (retryAttempted) {
      headers["X-Tsumugi-Evidence-Retry"] = `attempted=1;recovered=${retryRecovered ? 1 : 0}`;
    }
    if (profileEnabled) {
      // 品質の観測用（件数のみ。会話・claimの内容は含めない）
      headers["X-Tsumugi-Profile-Claims"] = `proposed=${profileStats.proposed};accepted=${profileStats.accepted};dropped=${Object.values(profileStats.dropped).reduce((n, v) => n + (v ?? 0), 0)}`;
    }
    // 観測性のみ（2026-09-23、判定ロジックは一切変更しない）：kill switchの実際の状態
    // （enabled=0/1）を含め、常にヘッダを返す。有効時はproposed/accepted/dropped、および
    // drop理由ごとの内訳（PersonMentionDropReasonの値ごとの件数のみ、内容は含めない）を
    // X-Tsumugi-Evidenceと同じ形式で付ける。無効時はenabled=0だけを返す
    // （PERSON_MEMORY_ENABLEDが意図せず無効化されていないかを、常にログから判別できるようにする）。
    if (personEnabled) {
      const personDroppedTotal = Object.values(personStats.dropped).reduce((n, v) => n + (v ?? 0), 0);
      const personDropReasonsPart = Object.entries(personStats.dropped)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(",");
      headers["X-Tsumugi-Person-Mentions"] =
        `enabled=1;proposed=${personStats.proposed};accepted=${personStats.accepted};dropped=${personDroppedTotal}` +
        (personDropReasonsPart ? `;dropReasons=${personDropReasonsPart}` : "") +
        (personStats.relationStripped > 0 ? `;relationStripped=${personStats.relationStripped}` : "");
    } else {
      headers["X-Tsumugi-Person-Mentions"] = "enabled=0";
    }
    // 観測性のみ（Person Mentionsと同じ設計）：kill switchの実際の状態（enabled=0/1）を
    // 含め、常にヘッダを返す。「LLMが出さなかったのかvalidationで落ちたのか分からない」
    // という状態を避けるため、有効時はproposed/accepted/dropped・drop理由ごとの内訳
    // （TopicEventDropReasonの値ごとの件数のみ、内容は含めない）を必ず付ける。
    if (topicEnabled) {
      const topicDroppedTotal = Object.values(topicStats.dropped).reduce((n, v) => n + (v ?? 0), 0);
      const topicDropReasonsPart = Object.entries(topicStats.dropped)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(",");
      headers["X-Tsumugi-Topic-Events"] =
        `enabled=1;proposed=${topicStats.proposed};accepted=${topicStats.accepted};dropped=${topicDroppedTotal}` +
        (topicDropReasonsPart ? `;dropReasons=${topicDropReasonsPart}` : "");
    } else {
      headers["X-Tsumugi-Topic-Events"] = "enabled=0";
    }
    return Response.json({ ...parsed, memories: finalizedMemories }, { headers });
  } catch {
    return Response.json(
      { error: "Failed to parse AI response as JSON." },
      { status: 502 }
    );
  }
}
