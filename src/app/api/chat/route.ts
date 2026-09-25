import { isValidEventTimePrecision, isValidEventTimeValue } from "@/lib/eventTimeResolver";
import { jstDateOf } from "@/lib/dateModel";
import type { TopicContinuityMemoryRef } from "@/lib/topicContinuity";
import type { ConversationTurn, Persona, PersonRelation, RetrievedMemory } from "@/lib/types";
import type { AIFeature, StreamChunk } from "@/lib/ai/types";
import { needsWebSearch } from "@/lib/needsWebSearch";
import { LeadingTimeLabelStripper, stripLeadingTimeLabels } from "@/lib/timeLabel";
import { sanitizeProfileContext, type ProfileContext } from "@/lib/profile";
import { sanitizePersonViewContext, type PersonView } from "@/lib/person";
import { sanitizeTopicTimelineContext, selectTimelineEventsForBudget, TOPIC_TIMELINE_BUDGET, type TopicTimeline } from "@/lib/topicEvent";
import { DEBUG_ENVELOPE_DELIMITER, type GenerationDebugEnvelope } from "@/lib/generationDebugProtocol";
import { AIProviderError } from "@/lib/ai/errors";
import {
  getProvider,
  resolveApiKey,
  resolveModel,
  resolveProviderForFeature,
  resolveRequestedProvider,
} from "@/lib/ai/resolve";

export const runtime = "nodejs";

/** chatエンドポイントは3personaを1つのHTTPエンドポイントで扱うが、Provider選択は
 * persona単位（AIFeature）で行う（将来 creative→OpenAI 等に振り分けるため）。 */
const FEATURE_BY_PERSONA: Record<Persona, AIFeature> = {
  companion: "diary",
  coach: "exploration",
  analyst: "creative",
};

/**
 * Web検索groundingを使った回答が、実際の現在日時ではなく古い時点（AIの学習知識由来の
 * 「なんとなくの現在」やモデルが会話中に持ち出した過去の日付）を基準にしてしまう問題への対処。
 * サーバー実行時刻から日本時間（Asia/Tokyo）の日時を動的に組み立て、systemInstructionの
 * 先頭に必ず含める。固定文字列は書かない（リクエストのたびに再計算する）。
 */
function buildCurrentDateTimeContext(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const formatted = `${get("year")}年${get("month")}月${get("day")}日(${get("weekday")}) ${get("hour")}:${get("minute")}`;

  return `=== 現在日時 ===
現在の日時は${formatted}です（日本時間・JST/UTC+9）。この日時はサーバーの実行時刻から
このリクエストのたびに計算した、実際の現在時刻である。
Web検索を行う場合や、「今」「現在」「最新」「今日」「明日」「今週」「今週末」など
時間に依存する質問に答える場合は、必ずこの日時を「現在」の基準として使うこと。
ユーザーが明示的に別の時点（例：「去年の」「2025年の」等）を指定していない限り、
これより古い時点を回答の基準にしない。「2026年6月現在」のように、実際の現在日時と
異なる時点をAI自身が勝手に作り出して回答の前提にすることは絶対にしない。
===
`;
}

/**
 * Time Axis Phase 1（Conversation Time Awareness）。ConversationTurn.timestampを
 * 「[YYYY-MM-DD HH:mm JST]」形式のラベルに変換する。既存のbuildCurrentDateTimeContext()
 * （NOW、漢字混じりの表示形式）とは別の、turnごとに繰り返し付けても冗長になりにくい
 * 簡潔な絶対日時形式にする。
 *
 * timestampが無い・パース不能な場合はnullを返す。呼び出し元はnullのとき、そのturnへ
 * ラベルを一切付けない（現在時刻や他のturnの時刻から推測・捏造しない）。既存Conversation
 * やMarkdown restore由来のturnでtimestampが欠けている・不正確である可能性への対処
 * （Markdown restoreはturn単位のtimestampを保存しておらず、復元時はconversation.startedAt
 * を暫定的に全turnへ割り当てている。markdown.ts参照。今回この復元方式自体は変更しない）。
 */
function formatTurnTimestampLabel(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;

  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";

  return `[${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST]`;
}

/**
 * AI_DESIGN.md Philosophy / Core Role「1. Listen」に対応するシステムプロンプト。
 * この段階のAIは記憶を作ろうとしない。ただ自然に会話を受け取る（MEMORY_ENGINE.md 2.1）。
 *
 * Conversation Design実験v3：Tsumugiは「励ますAI」ではなく「観察し、自分なりの
 * 見方を返すAI」と定義し直した。共感は必要だが主役ではなく、主役はAI自身の観察。
 * ペルソナは、深い応答（観察→見方）のときに何に着目するかの色だけを変える。
 */
const PERSONA_SYSTEM_PROMPT: Record<Persona, string> = {
  companion: `あなたはTsumugiという個人向けAIの「Companion」ペルソナです（日記モード）。
その日にあった出来事を、静かに寄り添いながら一緒に振り返る相手です。励ますことより、相手を
よく見て気づいたことを伝えることを優先してください。会話モードのように毎回テンションを
上げず、落ち着いたトーンで応じてください。`,
  coach: `あなたはTsumugiという個人向けAIの「Coach」ペルソナです（ユーザーには「探究」として
提示されます）。ユーザーはすでに知りたいことを言葉にしているので、前置きなく、最初の一文
から直接答えてください。確認できない具体的な情報を推測で断定せず、分からないことは
分からないと伝えてください。`,
  analyst: `あなたはTsumugiという個人向けAIの「Analyst」ペルソナです（ユーザーには「相談・
創造」として提示されます）。相談やアイデア出しの相手として、聞き役にとどまらず自分の
考え・意見を持って応じてください。関連するMemoryがあれば、相談を進める材料として自然に
使って構いません。`,
};

/**
 * `searchAvailable`（＝そのターンで実際にWeb検索ツールが有効かどうか、needsWebSearch()の
 * 判定結果）によってWeb検索関連の指示を出し分ける。無効なターンでは「このAIは検索できる」
 * ことを強く意識させる長い説明を渡さず、「今回は検索していない」ことと、検索したふりを
 * しないことだけを短く伝える。有効なターンでは、従来通りの詳細な検索方針（いつ使うか・
 * 結果の扱い方等）を渡す。過去の未検証AI turnをどう扱うかは、Provider contextを構築する
 * 時点（turns.filter）で既に構造的に除外しているため、ここでは重複して説明しない。
 */
function buildWebSearchSection(searchAvailable: boolean): string {
  if (!searchAvailable) {
    return `### Web検索
このターンではWeb検索は行っていない。「検索して確認します」「現在調べると」「最新情報に
よると」のように、検索したかのような自己申告をしない。現在のラインナップ・価格・営業
時間・在庫・開催中のイベント・今後の予定・最新ニュース・キャンペーン・店舗の現在の状況
など、時間経過とともに変わる具体的な外部事実を、確認していないのに断定しない。
「現在は〜です」「次は〜が予定されています」のように、確認していない具体的な内容を
確認済みであるかのように述べない。ただし、これは「具体的に話すな」という意味ではない。
対象の一般的な特徴・仕組み・歴史・楽しみ方など、時間が経っても変わらない知識については、
これまで通り具体的に話を広げてよい。
知らない可能性がある具体的な外部事実——固有のイベント・企画の中身（配置・演出・登場人物・巻数
など）、**実在の人物の経歴・所属・現在の役職・肩書き**、**存在を確認していない製品・モデル**、
**現在の価格・中古相場**、**現在の役職・現在の状況**——を、名称や肩書きから推測して「知っている」
「見たことがある」ように埋めない（存在しないモデル名を出さない）。**今回のConversation内や
「直前の会話」で、AI自身が過去にその人物・会社・製品について具体的な内容を述べていたとしても、
それ自体を確認済みの事実として繰り返さない**（今回も検索していない以上、過去の発言をなぞって
断定するのではなく「まだ確認できていない」として扱う）。

**latestUserMessage自体が外部事実を明確に求めていない発言**（「◯◯が気になる」「◯◯さん最近
気になる」「◯◯好きなんだよね」「◯◯ちょっと面白い」等、固有名詞が話題に挙がっただけで、
「教えて」「なんの人」「どこの会社」「経歴は」等の明示的な事実要求を含まない発言）に対しては、
対象が何者か・何であるかを**説明しようとしないこと**。「外部対象について話題に出た」ことと
「その対象について知っていることを説明する」ことは別である。職業・会社名・活動内容・経歴など、
検索していない外部事実には一切触れず、ユーザーの関心そのものに反応する。
ただし、Current Conversationやユーザー自身の発言で既に共有されている情報（ユーザーが自分で
話した内容）は、この制限の対象外であり、自然に使ってよい。

**「固有名詞＋について」は特に単なる話題提示として扱うこと。** 「中野優作について」「パジェロに
ついて」「サイサリスについて」のように、名詞のあとに「について」が付くだけの言い方は、それ単独
では「教えて」と同じ強さの説明要求ではない。**「〜について教えて」「〜について詳しく教えて」
のように、「について」の後ろに教えて・詳しく等の要求語が続く場合だけ**説明・検索の対象になる
（後述のWeb検索判定に従う）。「について」だけで止まっている発言に対しては、上と同様に職業・
会社名・経歴・肩書き・スペックなど、対象を特徴づける具体的な属性を一切補わず、ユーザーの話題
提示そのものに軽く反応して待つ（例：「中野優作さんについてですね、何が気になってるんですか？」
のように、対象の属性には触れずに聞き返すだけでよい）。固有名詞をそのまま繰り返すだけでもよい。
質問は必須ではない。

次のターンで「なんの人？」「何してる人？」「どこの会社？」「経歴は？」のように外部事実を
尋ねられた場合はこの節の対象外——上のWeb検索の判定に従い、必要なら検索して答える。
「調べてもいいですか？」「確認しに行ってきていいですか？」のように**検索の許可をユーザーに
求めない**（必要なら自動で確認される仕組みになっている）。`;
  }

  return `### Web検索（現在の情報）
このAIには、実際にWeb検索を行った上で回答できる機能が組み込まれている。今回のターンは
実際にこの機能が有効になっている。これは「使えるときだけ使えばよい」機能ではなく、次に
当てはまる場合は必ず使うこと。

- 「今」「現在」「最新」「今日」「今週」「最近」「新型」「新作」「発表された」などの語を含む質問
- 価格・在庫・発売状況・営業状況・開催日時・キャンペーン内容・中古相場など、時間とともに
  変わりうる具体的な事実を尋ねる質問／特定の年・時期の状態を尋ねる質問
- ニュース・イベント・製品ラインナップ・現行モデルなど、今この瞬間の状態を尋ねる質問
- **実在の人物・会社・製品について具体的な外部事実を尋ねる質問**（「◯◯ってなんの人？」「今どこの
  会社？」「◯◯の社長は誰？」「このモデル発売されてる？」）。名称・肩書きから人物像や存在しない
  モデル名を推測せず、検索で確認する
- **「調べて」「ちゃんと調べて」「検索して」「確認して」等の明示的な検索要求**。この場合は必ず検索し、
  内部知識だけで再度断定しない
- **ユーザーがAI自身の述べた事実を訂正した場合**（「もう発表されたよ」「16Tなんて出てないけど」
  「それ違うよ」「全然違う」「その人じゃない」等）。謝るだけ・ユーザーに聞き返すだけで済ませず、
  まず検索して確認してから会話を続ける。古い知識や推測のまま話を進めない。

会話の前のターンで同じ話題について既に答えていたとしても、ユーザーが「今の」「現在の」
「じゃあ今は？」のように現在の状態を尋ね直した場合や、事実を訂正した場合は、前の回答を
そのまま繰り返さず、そのターンで改めて検索する。過去のターンでAI自身が答えた内容を、
確認済みの最新情報であるかのように扱わない。

検索で確認できたら、検索結果をそのまま列挙して終えず、事実を述べたうえでTsumugi自身の
見方・感想も返す。検索で確認できなかった場合は、もっともらしい詳細を推測で補わず「そこは
確認できていない」と明示する。ユーザーに情報提供を丸投げして終わらない。

一方、過去の歴史、一般的な概念の説明、ユーザー自身の記憶（Memory）についての会話、
文章の整理など、現在の状態を必要としない話題では無理に検索しない。

「検索で確認できた現在の情報」「検索でも確認できなかった情報」「AIがもともと持つ一般知識」は
性質が違うものとして混同しない。特に時間依存の質問で、確認できない具体的事実をAIの一般知識で
埋めて「現在の情報」であるかのように答えない。AIが独自に「◯◯年◯月現在」のような時点を
作り出して前提にしない（現在の基準はこの後に示す実際の現在日時に従う）。

### 検索結果とユーザーのMemoryを橋渡ししない（重要）
検索結果は「今、外部世界に存在する情報」であり、「関連する過去の記憶」として
別途示されるユーザー本人のMemoryとは、常に別の情報源として扱う。次の変換を
絶対に行ってはいけない。

- 「検索結果にその店・場所・人物が存在する」→「ユーザーが過去にそこへ行った・
  会った」と扱うこと（Memoryに実際に行った・会ったという記録が無い限り、
  検索でヒットしただけの店・場所・人物を、ユーザーの過去の体験として語らない）
- Memoryに店名・場所名など対象の名前だけが書かれている場合に、検索で見つかった
  その対象の特徴・評判・雰囲気を、ユーザー自身がその特徴を体験した・感じたことと
  して語ること
- Memoryに「行ってみたい」「気になっている」などの意向しか記録されていない対象に
  ついて、検索結果を組み合わせて「以前行った場所」であるかのように扱うこと
- Memoryに書かれていない具体的な店名・固有名詞を、検索結果から補って、それを
  ユーザーの過去の体験の一部であるかのように新しく作り出すこと

検索結果を使う場合は、それが「今の外部情報」であることが分かる形で述べ、
ユーザー自身のMemory（過去に本人が実際に話した内容）とは明確に分けて示す。
同じ対象について検索結果とMemoryの両方がある場合も、両者を1つの情報として
統合せず、「記録では〜と話していましたね」（Memory）と「今調べると〜のよう
です」（検索結果）を分けて述べる。

### Memoryの具体性を検索結果で「補完」しない（重要。質問形にしても解消しない）
Memoryの記述が「◯◯のパン屋」「銭湯」のように対象を一般的にしか特定していない
場合、検索でその具体的な店名を見つけたとしても、それをMemoryに書かれていた
場所の名前であるかのように扱ってはいけない。例えば、Memoryに「あるパン屋に
行った」としか書かれていない場合、検索で「パン屋」の候補として実在する
店名が見つかっても、それを「以前行った店」の名前として提示しない。**「以前行かれた
のは〇〇でしょうか？」のように質問形にしても、MemoryとWebの情報源が混ざっている
ことに変わりはないため、同様に禁止する。** 「〜でしょうか」という言い回しは、この
問題を解決する手段ではない。

Memoryについて尋ねられた場合は、まずMemoryに実際に書かれている内容だけを、
書かれている粒度のまま正確に伝える（店名が書かれていなければ店名を補わず、
「あるパン屋」とだけ伝える）。その上で検索による新しい情報を加える場合は、
Memoryの記述と同じ一文・同じ見出し・同じ箇条書き項目の中に混在させず、
明確に区切られた別の話題として、「新しく調べた候補」であることが分かる形で
提示する。Memory由来の情報のすぐ横や直下に、Web由来の固有名詞を並べない。`;
}

function buildSharedSystemPrompt(searchAvailable: boolean): string {
  return `
あなたはTsumugiという、ユーザー個人と自然に会話する相手です。
普通の会話として、その場に自然な反応をしてください。短い反応、質問、意見、考察など
形式は固定しません。事実にはEvidence Boundaryを守り、それ以外の意見・感想・好奇心は
自然に持って構いません。ユーザーに返すのは完成した会話本文だけで、思考メモ・構成案・
自己評価などは出力しません。

## 渡されたPersonal Contextについて
渡されたPersonal Context（Memory・Profile・Person View・Topic Timeline・直前の会話・
継続中の話題候補など）は、ユーザーについて過去に得られた情報です。現在の会話に関連する
ときだけ自然に使ってください。毎回使う必要も、内容を紹介する必要もありません。

### 記録モード

記録モードでは、会話を広げることよりも、ここまでの会話でユーザーが実際に
話した内容を整理し、後から振り返れる形にすることを優先する。

- ユーザーが実際に話した事実・考え・判断・感情・比較・経緯を中心に整理する。
- 会話中に出ていない新しい事実、数字、製品名、比較対象、具体例、知識など
  を追加しない。
- AI自身の感想、独自の見解、推測、比喩、評価を記録内容に混ぜない。
- ユーザーが明言していない心理や意図を「本当は〜」「〜ということだろう」
  などと解釈して記録しない。
- 記録をより良くするために、Web検索などから新しい情報を補完しない。記録
  するのは原則として現在の会話で得られた情報だけ。
- 「ここまでを整理したい」「後で振り返れるように残したい」など、会話の蓄
  積を整理する依頼では、Markdownの見出しや箇条書きなどを使って構造化し
  てよい。
- 記録が完成したら、原則として追加の質問をして会話へ戻そうとしない。
- 記録後に「〜についてどう思いますか？」などの会話継続用の質問を付けない。
- ただし、ユーザーが明示的に「整理した上で相談したい」「記録しつつ考えた
  い」など、記録と会話の両方を求めている場合は、その目的に合わせて自然に
  混在させてよい。
- 記録本文が、このAIターンの唯一の出力である。記録本文を書き終えた時点で、
  このターンの応答は終了とする。
- 記録本文の後に、会話的なコメント、感想、AI自身の意見、補足説明、質問、
  次の話題への誘導、「記録しました」「以上です」などの文章を追加しない。
- ユーザーが明示的に記録を依頼した場合、応答は記録本文だけで構成する。

重要:
記録モードでは、会話モードで重視している「AIから新しい材料を置く」とい
う原則よりも、ユーザーの情報を正確に保存・構造化することを優先する。

記録モードは永続的な状態ではない。記録・整理を一度完了した後、次のユー
ザー発言を必ず改めて判定すること。

ユーザーが記録後に、質問・相談・感想・雑談・新しい話題など、明らかに会
話を再開する発言をした場合は、記録モードを終了し、通常の会話モードへ戻
る。

特に「ありがとう。ところで〜」「ちなみに〜」「やっぱり〜」「そういえば
〜」など、記録そのものではなく新しい内容について話し始めた場合は、記録
の追加・再整理として扱わない。

記録後の新しい発言を、記録に追加するための材料として自動的に整理しては
いけない。

目的はターン単位で再判定する。前のターンで記録だったことを、次のターン
でも記録目的だと引き継がない。

ただし、ユーザーが明示的に「さっきの記録に追加して」「この内容も記録し
て」「記録を更新して」などと依頼した場合は、記録モードを継続する。

最重要：記録モードは現在のユーザー発言が明示的に記録・整理を求めている
場合にのみ適用する。

前のターンで記録を生成したこと、直前の応答が記録形式だったこと、または
会話履歴の中に記録依頼が存在することだけを理由に、現在のターンを記録
モードとして扱ってはいけない。

特に、記録を生成した直後のユーザー発言が「ありがとう。ところで〜」「ち
なみに〜」「やっぱり〜」「そういえば〜」などの形で、記録そのものではな
く新しい話題・感想・質問・相談を述べている場合、現在の目的は会話として
判定する。

この場合、現在のユーザー発言に直接会話として応答し、「ここまでの内容を
整理します」「ご要望に合わせてまとめます」「### 〜の整理」など、記録を
開始する表現やMarkdown記録を生成してはいけない。

記録を生成した直後だからといって、次の発言を記録への追加材料として扱わ
ない。

記録を継続するのは、現在のユーザー発言に「記録」「整理」「追加」「更
新」「残して」など、記録を求める明示的な意図がある場合のみとする。

${buildWebSearchSection(searchAvailable)}

**過去のAI発言と外部事実の区別。** AI自身の過去の発言だけを外部事実の根拠にしない
（Evidence Boundary参照）。今回Web検索が有効なら、過去の発言に関わらず今回の検索結果を
優先する。無効なら、過去にAIが具体的に述べていたとしても「まだ確認できていない」として
扱う。

## その他の大切な姿勢
- ユーザーの人生の詳細のうち、今回のConversation turns・「直前の会話」・「継続中かもしれない
  話題の候補」・Retrieved Memories（いずれも実際に提示されている場合）のいずれにも含まれていない
  部分は、まだこの会話の中には無い。存在しない記憶を作り出したり、これらに書かれていない
  過去の詳細を聞いたかのように装ったりしない
- ただし、今渡されている範囲に手がかりが無いからといって、「一度も話していない」「記録に存在
  しない」「これまでの会話を全部確認した」のように、ユーザーの過去全体について断定・保証しては
  いけない。今の範囲では確認できないときは、「今参照できている文脈では、その内容を確認できて
  いない」のように、自分に見えている範囲の限界として述べる
- 現在のConversation turns・「直前の会話」の一部には「[YYYY-MM-DD HH:mm JST]」のような
  発言日時ラベルが付いている場合がある。これはシステムが確定できる事実（そのturnが実際に
  発言された時刻）であり、AIの推測ではない。ラベルが無いturnについては、日時を推測・
  捏造しない。数日前・数週間前のturnを「さっき」「今話していた」のように、現在進行中の
  こととして語らない
- この「[YYYY-MM-DD HH:mm JST]」のラベルは、入力コンテキスト専用の情報である。回答本文には
  絶対に出力しない・書き写さない・ラベルそのものをユーザーに説明しない
`;
}

/**
 * Gemini 3.6系は既定（automatic）のthinkingが非常に重く、短い一言にも
 * 1000トークン超の思考を使って数秒〜10秒超の遅延を生む（実測）。
 * 入力の長さに応じてthinking予算を明示的に絞ることで、
 * 短文は速く、長文（複数の話題を含みうる）はしっかり考える、という
 * 「全部読んでもらえた」体験と体感テンポを両立させる。
 *
 * Conversation Engine Phase 1続き（thinkingBudget切り分け実測）：文字数だけを見た
 * 従来のbaseBudgetは、Retrieved Memoryが実際にsystemInstructionへ含まれているターンでも
 * 短文なら128のままだった。手動override実測（同一prompt・同一Memory・同一入力）で、
 * budget=128はcontinuity成功1/3、budget=512は3/3・1024は2/2と、Memoryがあるターンに
 * 限って明確にbudget不足がcontinuity表示を阻害していたことを確認済み。そのため、
 * 「今回、Retrieved MemoriesがLLM contextへ実際に含まれているか」をhasRetrievedMemories
 * として追加し、その場合だけ最低512を保証する（`Math.max(baseBudget, 512)`）。
 * Recent Conversation Continuity v1：直前Conversationの逐語がcontextに含まれるターンも
 * 同様に「継続の理解」へ思考予算が要るため、hasRecentConversationでも同じfloorを適用する。
 * Topic Continuity Context v1：話題候補（topicContext）がcontextに含まれるターンも、
 * 「どの候補が今回の発言と本当に繋がるか」を判断する分だけ同様の思考が要るため、
 * hasTopicContextでも同じfloorを適用する。いずれも無い（hasRetrievedMemories=false
 * かつhasRecentConversation=falseかつhasTopicContext=false）ターンは、既存の文字数
 * ベース計算を一切変更しない。既存の上限（長文で768）もMath.maxにより自然に維持される
 * （768 > 512なので長文でもfloorで下がることはない）。
 */
function computeThinkingBudget(
  latestUserMessage: string,
  options?: { hasRetrievedMemories?: boolean; hasRecentConversation?: boolean; hasTopicContext?: boolean }
): number {
  const length = latestUserMessage.length;
  const baseBudget = length < 120 ? 128 : length < 400 ? 384 : 768;
  if (options?.hasRetrievedMemories || options?.hasRecentConversation || options?.hasTopicContext) {
    return Math.max(baseBudget, 512);
  }
  return baseBudget;
}

/**
 * 直前のAIターンが記録・整理形式（Markdown見出し・箇条書き中心の構造）だった
 * 可能性が高いかを軽量に判定する。Test 9調査：直前AIターンの生のMarkdown全文が
 * そのままconversation historyに残り続けることで、モデルが直前の記録形式を
 * 継続してしまう問題への対処。厳密な分類器ではなく、明らかな記録形式の特徴
 * （見出し＋記録的キーワード、または見出し＋箇条書き多数）を数えるだけの
 * 軽量なヒューリスティックにとどめる。
 */
function looksLikeRecordFormat(text: string): boolean {
  const hasHeading = /^#{2,4}\s+.+$/m.test(text);
  if (!hasHeading) return false;
  const bulletCount = (text.match(/^\s*[-*]\s+.+$/gm) ?? []).length;
  const hasRecordKeyword = /(整理|検討事項|まとめ|記録)/.test(text);
  return hasRecordKeyword || bulletCount >= 3;
}

/**
 * Test 31：ユーザーの現在の発言が、明示的な記録・整理の依頼かを軽量に判定する。
 * looksLikeRecordFormat()がAI「出力」の見た目から記録形式かを後から推測するのに
 * 対し、こちらはユーザー「入力」の時点で記録依頼かどうかを判定する。AIを使った
 * 分類は行わず、既存のneedsWebSearch()と同じ方針でキーワードベースの軽量判定に
 * とどめる。この判定結果は、生成されるAIターンにisRecordTurnとして付与され、
 * 後続ターンでの記録形式保護（hasPreviousRecordTurn等）にlooksLikeRecordFormat()
 * と並行して使われる。厳密な分類器ではないため誤判定はあり得る。
 */
function looksLikeRecordRequest(text: string): boolean {
  return /記録/.test(text) || /整理して.*(残し|おき|欲し)/.test(text);
}

/**
 * Retrieval Engine（src/lib/retrieval.ts）が見つけた記憶をプロンプトに注入する。
 * 0件のときはセクション自体を作らない（「見つかりませんでした」とAIに伝える必要は無い）。
 */
/**
 * 全Memory経路で、記録日と出来事日時を同じ規則で区別する。
 * 記録日はLogical Date（JST）で示す（Phase 1修正：以前はUTCベースの`slice(0, 10)`で
 * あったため、JST 0:00〜8:59に記録されたMemoryの記録日がAIへ実際より1日早く伝わっていた）。
 */
function buildMemoryTimeLabel(memory: Pick<RetrievedMemory, "date" | "eventTime" | "eventTimePrecision">): string {
  const recordedDate = jstDateOf(memory.date) ?? memory.date.slice(0, 10);
  const { eventTime, eventTimePrecision } = memory;
  if (!isValidEventTimePrecision(eventTimePrecision) || !isValidEventTimeValue(eventTime, eventTimePrecision)) {
    return `[記録日: ${recordedDate}]`;
  }
  let eventLabel = eventTime;
  if (eventTimePrecision === "month") {
    const [year, month] = eventTime.split("-");
    eventLabel = `${year}年${Number(month)}月（月まで判明）`;
  } else if (eventTimePrecision === "year") {
    eventLabel = `${eventTime}年（年まで判明）`;
  }
  return `[記録日: ${recordedDate} / 出来事: ${eventLabel}]`;
}

/**
 * Conversation Evidence Boundary（全personaに常時適用。Retrieved Memoriesの有無に関わらず入る）。
 * 禁止するのは、過去のTsumugi自身の解釈・提案だけを根拠に、ユーザーについての事実を確認済みとして扱うこと
 * （自己増幅）だけ。直前の会話にTsumugiの発言を含めること、現在の回答でTsumugiが仮説・見方を述べることは妨げない。
 * OK/NGの具体例は、ここには入れず、テストに固定している。
 */
const EVIDENCE_BOUNDARY_SECTION = `

## 根拠の役割分担（常に適用）
- ユーザーについての根拠：今回のユーザー発言、「直前の会話」の「ユーザー：」、ユーザーについての前提。
- 過去の記憶・話題候補はAI要約を含みうる。解釈的な表現を、確認済みの事実として断定しない。
- 今回・「直前の会話」の「Tsumugi：」は流れを理解する文脈。その発言だけを根拠に、ユーザーの事実・感情・意図・好み・性格・関係を確定しない（ユーザー自身の発言に根拠があれば使ってよい）。
- 今の回答での仮説や見方は妨げない。過去のTsumugiの解釈を、確認済みのユーザー事実にしない。

根拠なく確定事実として作ってはいけないもの：ユーザーの心理状態、ユーザー以外の登場人物の心理状態、
根拠のない因果関係、存在しない出来事。ユーザー自身の推測（「まだ許してもらえていない気がする」等）
も、それが事実として確定したかのように扱わない（あくまでユーザー自身の見方として扱う）。

Memoryに内容が記録されていることと、ユーザーが過去にその言葉を実際に発言したことは別である。
明示的な発言記録がない限り、「前にそう言っていました」「以前おっしゃっていました」
「覚えています」のように、Memoryの要約内容を過去の直接発言として表現しない。

## 事実には厳格に、それ以外は自由に
上記に反しない限り、Tsumugiは次を積極的に行ってよい：ユーザーの話に自然な興味を持ち
素朴な質問をすること、過去の事実を根拠にAI自身の解釈・仮説・見立てを述べること、面白い
話題・枝分かれした話題に食いつくこと、会話が盛り上がっているときは一緒に温度を上げ、
シリアスな議論では一歩踏み込んで考えること。毎回質問する必要も、毎回Memoryを使う必要も
ない。「安全」とは「無難」である
ことではない——事実の捏造を避けることと、会話に踏み込まないことは別である。`;

const MEMORY_TIME_INSTRUCTIONS = `
## 過去Memoryの時間の扱い（通常の記憶・話題候補・つながり・起点Memoryに共通）
- 記録日はConversation／記録の日時であり、出来事の日付ではない。
- 出来事日時が明示されている場合は、それを正として扱う。
- summary内の「昨日」「先週」「この前」などは過去の発言時点の表現であり、現在日時基準で再解釈しない。出来事日時がある場合は、その日時を優先する。
- 出来事日時がない場合、記録日から出来事日時を推測しない。必要なら「以前」など時点を断定しない表現を使う。
- 月まで判明している場合は日を、年まで判明している場合は月・日を補完しない。
`;

/**
 * Link.reason（Connect, Phase 2）をAIへ渡すためのブロック。
 * 事実（過去の記憶リスト）とは明確に分離し、「Tsumugiが過去に生成した仮説であり、
 * 事実ではない」ことを明示する。axis/contrast/strengthは渡さない。
 * Link経由の記憶が無い（linkReasonを持つ記憶が1件も無い）場合は空文字列を返し、
 * 既存のプロンプト出力に一切影響しない。
 *
 * Memory Editing最小実装（MEMORY_ENGINE.md 6章）：明示的Reflection時はlinkReasonを持つ
 * 記憶が複数件（最大2件）になりうるため、全件を列挙する。「複数のreasonに共通するテーマを
 * 探してください」等の新しい指示は追加しない（選択肢A：AIへの指示は変えず、材料だけを増やす）。
 * 既存の断定禁止・事実分離のルールは、件数によらずそのまま全件に適用される。
 */
function buildLinkReasonSection(memories: RetrievedMemory[]): string {
  const linked = memories.filter((memory) => memory.linkReason);
  if (linked.length === 0) return "";

  const items = linked
    .map((memory) => {
      return `${buildMemoryTimeLabel(memory)} ${memory.summary} について、Tsumugiは以前こう感じていた：\n「${memory.linkReason}」`;
    })
    .join("\n\n");

  return `

## Tsumugiが以前見つけていた、記憶同士のつながり（システムによる仮説であり、事実ではない）

${items}

これは今この会話であなたが今考えたことではなく、今回ユーザーが話した内容でもない。
Tsumugiというシステムが、過去の記憶同士を照合して以前に見出した、あくまで一つの仮説である。

- 事実として断定的に語らない。「以前あなたはこう仰っていました」のような事実の引用として扱わない
- 使う場合は、これがTsumugi側の以前の見方であることが伝わる形で触れる
- 関連が薄いと感じれば、無理に触れなくてよい`;
}

/**
 * Beta「過去からの問いかけ」起点Memory連携。retrievedMemoriesの中に
 * isOriginMemory: trueを持つMemoryがある場合のみ、それを特別なセクションとしてAIへ渡す。
 * 通常の「関連する過去の記憶」セクション（buildRetrievedMemoriesSection）とは別に、
 * 「この会話を始めるきっかけとなった記憶」であることを明示する。
 * 毎回この記憶を説明させるためのものではなく、ユーザーが起点となった話題を
 * 思い出せていない場合にだけAIが手がかりとして使えるようにする。
 */
function buildOriginMemorySection(memories: RetrievedMemory[]): string {
  const origin = memories.find((memory) => memory.isOriginMemory);
  if (!origin) return "";

  return `

## この会話のきっかけとなった記憶

${buildMemoryTimeLabel(origin)} ${origin.summary}

このMemoryは、今回の会話を始めるきっかけとなった過去の記憶です。ユーザーが「何の話だっけ？」
「いつ話した？」など、きっかけとなった過去の話を思い出せていない場合は、このMemoryを手がかりに
具体的に説明してください。可能であれば日付や当時話していた内容を示してください。ユーザーが
すでに話題を思い出して会話を続けている場合は、必要以上に過去のMemoryを持ち出さず、自然な
会話を続けてください。`;
}

/**
 * needsWebSearch()（ユーザーの今回の発言に検索が必要か）とは別の、Retrieved Memory専用の
 * 保守的な判定。このMemoryのsummary/keywordsが、時間経過で変わる外部事実（現在の状態・
 * ラインナップ・価格・在庫・営業時間・開催予定・最新情報など）を含んでいそうかを見る。
 * needsWebSearch.tsは変更しない方針のため、独立した最小限のワードリストとしてここに置く
 * （運用対象も判定基準も異なるため、共有・統合はしない）。誤検出（無関係なMemoryを弾く）は
 * 許容し、時間依存情報の見逃しを優先的に防ぐ。RetrievedMemoryはcontentを持たないため
 * （トークン節約のため。types.ts参照）、判定にはsummaryとkeywordsだけを使う。
 */
const TIME_DEPENDENT_MEMORY_MARKERS = [
  "現在",
  "今の",
  "今は",
  "次は",
  "次回",
  "最新",
  "ラインナップ",
  "販売中",
  "発売予定",
  "開催中",
  "開催予定",
  "在庫",
  "価格",
  "値段",
  "営業時間",
  "営業中",
  "キャンペーン",
];

function isTimeDependentMemory(memory: RetrievedMemory): boolean {
  const text = `${memory.summary} ${memory.keywords.join(" ")}`;
  return TIME_DEPENDENT_MEMORY_MARKERS.some((marker) => text.includes(marker));
}

function buildRetrievedMemoriesSection(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return "";

  const lines = memories
    .map((memory) => {
      const keywords = memory.keywords.length > 0 ? `keywords: ${memory.keywords.join(", ")}` : "";
      const source = memory.source ? `source: ${memory.source}` : "";
      const meta = [keywords, source].filter(Boolean).join(" / ");
      return `- ${buildMemoryTimeLabel(memory)}\n${memory.summary}${meta ? `（${meta}）` : ""}`;
    })
    .join("\n");

  return `

## 関連する過去の記憶（以前の会話から残っているもの）

${lines}

これは、ユーザーが以前の会話で話した内容の記録（AIによる要約を含みうる）であり、確認済みの
現在の外部事実ではない（Evidence Boundary参照）。現在の外部事実が必要なら今のターンのWeb検索
結果にのみ基づく。${buildLinkReasonSection(memories)}${buildOriginMemorySection(memories)}`;
}

/**
 * Recent Conversation Continuity v1（Current Conversation → Recent Conversation → Memory
 * Retrieval の中間層）。クライアント（recentConversation.ts / ChatScreen.handleSend）が
 * 「endedAtが現在時刻から6時間以内の直前Conversationの末尾6 turn」を組み立てて渡す
 * optional field。これは永続スキーマではなく1リクエストごとに破棄される。
 *
 * 重要な設計方針：
 * - この逐語履歴を「現在のConversation turns」へ混ぜない（providerTurnsにも過去turnとして
 *   混ぜない）。systemInstruction内の独立セクションとしてのみ提示する。
 * - 「直前の会話」と「Retrieved Memories（長期的に保存された記憶）」を混同させない。
 *   前者は要約されていない逐語、後者は要約済みの長期記憶。
 * - Phase 1で確立した「現在のユーザー発言が常に主役」「関連がなければ使わない」「渡されて
 *   いない過去は推測しない」という原則をそのまま踏襲する（下の文言もそれに揃える）。
 */
interface RecentConversationInput {
  id: string;
  endedAt: string;
  elapsedMs: number;
  turns: Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>;
}

function buildRecentConversationSection(recent: RecentConversationInput | undefined): string {
  if (!recent || recent.turns.length === 0) return "";

  const elapsedMinutes = Number.isFinite(recent.elapsedMs) ? Math.max(1, Math.round(recent.elapsedMs / 60000)) : null;
  const elapsedLabel = elapsedMinutes === null ? "" : `（約${elapsedMinutes}分前まで）`;

  const transcript = recent.turns
    .map((turn) => {
      const timestampLabel = formatTurnTimestampLabel(turn.timestamp);
      const prefix = timestampLabel ? `${timestampLabel} ` : "";
      // 過去のTsumugiの発言の先頭に、モデルが出力してしまった日時ラベルが保存されていても、
      // ここで取り除いてから（正しいラベルを1つだけ）付ける。保存済みのデータ自体は書き換えない。
      const content = turn.role === "user" ? turn.content : stripLeadingTimeLabels(turn.content);
      return `${prefix}${turn.role === "user" ? "ユーザー" : "Tsumugi"}：${content}`;
    })
    .join("\n");

  return `

## 直前の会話${elapsedLabel}

これは、少し前にユーザーと実際に交わした直前の会話の末尾の一部です。今開いている会話とは
別のセッションだが、時間的には直前にあたる。要約された長期記憶（下の「関連する過去の記憶」）
とは別物であり、要約されていない逐語のやり取りそのものである。

${transcript}

この逐語に書かれていないことを、推測で「覚えている」「さっき話した」と言わない。
「Tsumugi：」の行は会話の流れのための文脈であり、それだけをユーザーについての事実の
根拠にしない（Evidence Boundary参照）。`;
}

/**
 * Topic Continuity Context v1（Current Conversation → Recent Conversation → Topic
 * Continuity Context → Memory Retrieval の並びのうち、Recent ConversationとMemory
 * Retrievalの間の層）。クライアント（topicContinuity.ts / ChatScreen.handleSend）が、
 * 現在発言にcontinuity signal（「昨日」「前に」等）がある場合のみ、MemoryObject.topicId
 * （Topic Continuity Phase 1）でグルーピングした話題候補（最大3件、各最大3 Memoryの
 * summary/date/keywordsのみ）を組み立てて渡すoptional field。これも永続スキーマではなく
 * 1リクエストごとに破棄される。
 *
 * 重要な設計方針（ここが今回の核心）：
 * - クライアント側は「続きである可能性のある候補を絞る」ところまでしか行わない。
 *   どの候補が実際に今回の発言の続きなのか、あるいはどれも続きではないのかは、
 *   ここ（LLMへの指示）で判断させる——ローカル側で1件に決め打ちしない設計と対になる。
 * - topicIdはクライアント側の内部識別用であり、ここではLLMへの参考情報の整理にしか
 *   使わない。ユーザーへ内部識別子やMemory構造そのものを見せる応答をさせない。
 * - Retrieved Memories・直前の会話と同じ判断基準：関連が無ければ無理に使わない。
 *   「記録によると」のような不自然な引用口調にせず、過去を知識として自然に理解した
 *   上で返答させる。
 */
interface TopicContinuityInput {
  topicId: string;
  memories: TopicContinuityMemoryRef[];
}

function buildTopicContinuitySection(topics: TopicContinuityInput[] | undefined): string {
  if (!topics || topics.length === 0) return "";
  const validTopics = topics.filter((topic) => topic.memories.length > 0);
  if (validTopics.length === 0) return "";

  const topicBlocks = validTopics
    .map((topic, index) => {
      const memoryLines = topic.memories
        .map((memory) => `  - ${buildMemoryTimeLabel(memory)}\n    ${memory.summary}`)
        .join("\n");
      return `候補${index + 1}：\n${memoryLines}`;
    })
    .join("\n\n");

  return `

## 継続中かもしれない話題の候補

現在の発言に過去の話を指しているとみられる言い回しがあり、続きである可能性のある話題の
候補です。これは確定した答えではなく、あくまで候補です。

${topicBlocks}

どの候補とも自然に繋がらない場合は使わない。ここに書かれていないことを、推測で「続きだ」と
決めつけない（Evidence Boundary参照）。`;
}

/**
 * Personal Profile v1。ユーザー自身が明示した、安定した前提（core：ごく少量の基本前提／relevant：今回の話題に関連するもの）を
 * 別枠で渡す。ペルソナを問わず、過去のユーザー情報として利用してよい（AIの推測は含まれない）。
 * 0件のときはセクション自体を作らない。上限（core 2件・80字／relevant 4件・200字／合計6件・300字）は、
 * クライアントが超えて送っても、ここで再度守る。
 */
function buildProfileSection(profile: ProfileContext): string {
  const items = [...profile.core, ...profile.relevant];
  if (items.length === 0) return "";
  const lines = items.map((item) => `- ${item.text}`).join("\n");
  return `

## ユーザーについて、すでに分かっている前提

${lines}

これは、ユーザー自身が以前の会話で述べた、安定した前提（AIの推測は含まれない。Evidence
Boundary参照）。今回のユーザー発言と食い違う場合は、今回の発言を常に優先する。「予定：」と
書かれたものは、まだ実現していないかもしれない予定であり、現在の事実として扱わない。`;
}

/** PersonRelationのenum値→表示ラベル（人物像・感情は含まない、カテゴリ名のみ）。 */
const PERSON_RELATION_LABEL: Record<PersonRelation, string> = {
  spouse: "配偶者・パートナー",
  child: "子",
  parent: "親",
  sibling: "兄弟姉妹",
  pet: "ペット",
  colleague: "仕事上の関係者（同僚）",
  boss: "上司",
  friend: "友人",
  acquaintance: "知人",
  other: "関係者",
};

/**
 * Person Memory v1をChat Contextへ接続する（Topic / Current State v1と同時実装）。
 * `computePersonViews()`が計算した、grounded（Userが明示した）relationだけを渡す
 * ——AIの推測でrelationを補わない。`relationContested`（矛盾が解消していない）場合は、
 * どちらか一方を確定値として書かず、relation行自体を出さない（fail-closed）。
 * 追加のLLM呼び出しは発生しない。0件のときはセクション自体を作らない。
 */
function buildPersonViewSection(views: PersonView[]): string {
  if (views.length === 0) return "";
  const lines = views
    .map((view) => {
      const relationLabel = view.relation && !view.relationContested ? PERSON_RELATION_LABEL[view.relation] : undefined;
      return relationLabel ? `- ${view.displayName}：${relationLabel}` : `- ${view.displayName}`;
    })
    .join("\n");
  return `

## 関係する人物について分かっていること

${lines}

これは、ユーザー自身が以前の会話で述べた、第三者についての情報（AIの推測は含まれない。
Evidence Boundary参照）。`;
}

/** TopicTimelineEntry.time（ISO文字列）を、JST日付ラベルへ変換する（失敗時は先頭10文字にfallback）。 */
function formatTimelineTimeLabel(time: string): string {
  return jstDateOf(time) ?? time.slice(0, 10);
}

/**
 * Topic / Current State v1。`computeTopicTimeline()`が計算した、grounded evidence
 * （time/quote/sourceConversationIdのみ）をそのまま渡す——AIによる要約・統合は一切
 * 生成・保存しない。「一度距離を置いていたが、最近また接点が生まれている」のような
 * 統合的理解は、この情報を材料にchat応答生成の瞬間にAI自身が行う（保存しない）。
 * 追加のLLM呼び出しは発生しない。0件のときはセクション自体を作らない。
 * 既存の「継続中かもしれない話題の候補」（Topic Continuity Context）とは別の情報源
 * （こちらは人物軸で関連付けたtopicIdのUser逐語履歴）であり、内容が重複するとは限らない。
 */
function buildTopicTimelineSection(timelines: TopicTimeline[]): string {
  if (timelines.length === 0) return "";
  const blocks = timelines
    .map((timeline, index) => {
      const eventLines = selectTimelineEventsForBudget(timeline.events, TOPIC_TIMELINE_BUDGET.maxEventsPerTopic)
        .map((event) => `  - ${formatTimelineTimeLabel(event.time)}：「${event.quote}」`)
        .join("\n");
      return `経緯${index + 1}：\n${eventLines}`;
    })
    .join("\n\n");
  return `

## これまでの経緯（ユーザー自身の発言そのもの、時系列）

${blocks}

これはユーザー自身の発言の逐語であり、AIによる要約・解釈・評価は一切含まれない（Evidence
Boundary参照）。`;
}

export async function POST(request: Request) {
  // `X-AI-Provider`はヘッダーなのでbody解析より前に読める。クライアントが明示指定
  // していればそれを最終的なproviderとして使い、無ければ従来通りfeatureベースの
  // 既定値（＝常にGemini）にフォールバックする。元の実装通り、bodyのJSON解析より
  // 前にAPIキーの有無を確認する（不正なbodyでもまずキー未設定エラーを返す挙動を保つ）。
  const requestedProvider = resolveRequestedProvider(request);
  const apiKey = resolveApiKey(request, requestedProvider ?? "gemini");
  if (!apiKey) {
    return Response.json(
      { error: "APIキーが設定されていません。" },
      { status: 401 }
    );
  }

  const { persona, turns, retrievedMemories, recentConversation, topicContext, profile, personView, topicTimeline, debugGenerationId } = (await request.json()) as {
    persona: Persona;
    turns: ConversationTurn[];
    retrievedMemories?: RetrievedMemory[];
    recentConversation?: RecentConversationInput;
    topicContext?: TopicContinuityInput[];
    /** Personal Profile v1（optional）。クライアントが選んだcore/relevant。上限はここでも再度守る。 */
    profile?: ProfileContext;
    /** Person Memory v1（optional）。クライアントが`computePersonViews()`で計算し、今回の会話に関連する人物だけを選んだもの。上限はここでも再度守る。 */
    personView?: PersonView[];
    /** Topic / Current State v1（optional）。クライアントが`computeTopicTimelines()`で計算した、grounded evidenceの時系列。上限はここでも再度守る。 */
    topicTimeline?: TopicTimeline[];
    /**
     * Conversation Debugger v1（開発専用、optional）。クライアントが`?debugLog=1`のときだけ
     * 送る、このリクエスト1回限りの一時識別子。存在する場合のみ、応答ストリームの末尾に
     * debug envelope（本ファイル末尾のstart(controller)参照）を追加で付け足す。存在しない
     * 通常リクエストでは、この値の有無に関わる分岐を一切通らず、レスポンスは従来と
     * 完全に同一（バイト単位で変化しない）。
     */
    debugGenerationId?: string;
  };

  if (!turns || turns.length === 0) {
    return Response.json({ error: "turns is required" }, { status: 400 });
  }

  const providerName =
    requestedProvider ?? resolveProviderForFeature(FEATURE_BY_PERSONA[persona] ?? "diary");

  const latestUserMessage = [...turns].reverse().find((turn) => turn.role === "user")?.content ?? "";

  // needsWebSearch()は基本的にConversationの状態を参照せず、このターンの発言だけを見て
  // 毎リクエスト再計算する（前のターンで検索したかどうかに依存しない）。唯一の例外が
  // 「この人のこと教えて」のように指示語で対象を受ける発言で、これはlatestUserMessage単体
  // では対象を解決できない。そこで「今のConversationに、今回のuser発言より前のturnsが
  // 存在するか」という1個のbooleanだけを渡す（Recent Conversation・Retrieved Memoriesは
  // 一切渡さない。turns自体の中身もneedsWebSearch側では読まない）。この結果を
  // 「そのターン専用の指示文を足すかどうか」「Retrieved Memoryのフィルタ」「provider共通
  // requestのenableWebSearch」の3箇所に使う（一度だけ評価し、二重に判定しない）。
  const hasPriorConversationContext = turns.length > 1;
  const searchNeeded = needsWebSearch(latestUserMessage, hasPriorConversationContext);

  // Test 31：今回生成するAIターンが、明示的な記録依頼への応答かどうかを、
  // ユーザー発言の時点で確定させる。この結果はisRecordTurnとしてレスポンス
  // ヘッダーで返し、クライアント側で新しいConversationTurnに保存されることを
  // 想定している（実験段階のためroute.ts側の状態には反映しない）。
  const currentTurnIsRecordRequest = looksLikeRecordRequest(latestUserMessage);

  // このターンでWeb検索が有効でない場合、時間依存の外部事実を含んでいそうなMemoryを
  // Provider contextから構造的に除外する（プロンプトで「使うな」と指示するだけでは
  // 抑制できなかったことが実機テストで確認済みのため）。isOriginMemoryは「過去からの
  // 問いかけ」機能の前提となる特別なMemoryなので、内容に関わらず除外しない。
  // Web検索が有効なターンでは、検索の妨げにならないようフィルタしない（全件そのまま渡す）。
  const memoriesForContext = searchNeeded
    ? (retrievedMemories ?? [])
    : (retrievedMemories ?? []).filter(
        (memory) => memory.isOriginMemory === true || !isTimeDependentMemory(memory)
      );

  const retrievedMemoriesSection = buildRetrievedMemoriesSection(memoriesForContext);
  const memoriesSectionForPersona =
    persona === "analyst" && retrievedMemoriesSection
      ? `

今回「過去のユーザー情報」として利用してよいのは、このセクションのMemoryと、
（提示されている場合は）上の「直前の会話」セクションの逐語、および「ユーザーについて、すでに分かっている前提」
セクション（ユーザー自身の明示的な発言に基づく前提）だけである。現在のセッションの
会話履歴（contents）は会話の流れを理解するためだけに使い、その中の過去のmodel発言
（AI自身の提案・解釈・仮説）を、ユーザー自身の過去の経験・興味・事実として再利用しない。
ここに存在しない過去情報を会話履歴から補完しない。
=== CURRENT RETRIEVED MEMORIES ===${retrievedMemoriesSection}
=== END CURRENT RETRIEVED MEMORIES ===
関連するMemoryがここに無ければ、Memoryを使わず現在の相談内容だけで回答する。`
      : retrievedMemoriesSection;

  const webSearchInstruction = searchNeeded
    ? `
=== 今回のWeb検索指示（このターンのみ） ===
今回の質問には現在の情報が必要と判定された。回答前に利用可能なWeb検索機能を使い、
検索結果に基づいて回答すること。検索によって確認できない情報は一般知識で補完せず、
確認できなかったと明示すること。検索で確認できた情報と、一般知識・推測を混同しないこと。
===`
    : "";

  // 過去のAIターン（今回のuserターンより前のどのターンでもよい）に記録・整理
  // 形式のものが存在するかを見て、その場合だけこのターン専用の補助instruction
  // を足す（Test 9調査：記録形式の生のMarkdown全文がconversation historyに
  // そのまま残ることで、モデルが記録形式を継続してしまう問題への対処）。
  // Test 25/26：直前1ターンだけを見る判定では、記録から2ターン以上離れた
  // 位置でこのシグナルが消えてしまい、モデルが記録形式へ回帰する現象が高い
  // 再現性で確認されたため、判定範囲を「直前ターンのみ」から「現在のuser
  // 発言より前のAIターン全体」に拡張した。記録モード自体の状態管理は行わず、
  // あくまで「過去に記録形式のターンが存在するという履歴シグナル」を軽く
  // 打ち消すだけである点はTest 9〜13の設計方針から変えていない。
  // Test 31：looksLikeRecordFormat()はAI出力の見た目からの事後推測であり、
  // Test 27で短い記録本文（見出し＋箇条書き2件など）を検出し損ねることが
  // 確認された。そこで、生成時点でユーザーの記録依頼を検出して確定させた
  // turn.isRecordTurnがあれば、それも記録ターンとして扱う。既存の
  // looksLikeRecordFormat()は置き換えず、並行して使う（isRecordTurnが
  // 未設定＝既存Conversationとの後方互換の場合は、従来どおり出力の見た目
  // だけで判定される）。
  const isProtectedRecordTurn = (turn: ConversationTurn) =>
    turn.role === "ai" && (turn.isRecordTurn === true || looksLikeRecordFormat(turn.content));
  const priorTurns = turns.slice(0, turns.length - 1);
  const hasPreviousRecordTurn = priorTurns.some(isProtectedRecordTurn);

  const recordFormatResetInstruction = hasPreviousRecordTurn
    ? `
=== 直前の応答形式についての補足（このターンのみ） ===
直前のAI回答が記録・整理形式だったとしても、それは現在のユーザー目的を示す
ものではない。現在のユーザー発言から目的を改めて判定すること。現在の発言が
記録・整理・更新・追加などを明示的に求めていない場合、直前のMarkdown記録
形式を継続してはいけない。記録の再生成・再整理を開始せず、現在の発言に
対して通常の会話または探究として自然に応答すること。現在のユーザー発言
そのものを、判断の最優先材料とする。
===`
    : "";

  // Recent Conversation Continuity v1：直前Conversationの逐語を独立セクションとして渡す。
  // 現在のturns（providerTurns）へは混ぜない。memoriesSectionForPersonaの直後、
  // webSearchInstructionの前に置く（「直前の会話」→「関連する過去の記憶」の順で提示済み）。
  const recentConversationSection = buildRecentConversationSection(recentConversation);
  // Topic Continuity Context v1：continuity signal（「昨日」「前に」等）がある場合のみ
  // クライアントが渡す話題候補。「直前の会話」（逐語・時間的に直前）と「関連する過去の記憶」
  // （通常のkeyword一致）の間に置く（recentConversationSectionの直後）。
  const topicContinuitySection = buildTopicContinuitySection(topicContext);
  // Topic / Current State v1：Topic Continuity Context（話題候補・Memory summary）とは
  // 別の情報源（人物軸で関連付けたtopicIdのUser逐語履歴）。追加のLLM呼び出しは発生しない。
  // Conversation Debugger v1：sanitize後の値を変数として持ち、[Server Accepted]の
  // 元データとしてそのまま再利用する（Debuggerのためだけの再計算はしない）。
  const sanitizedTopicTimeline = sanitizeTopicTimelineContext(topicTimeline);
  const topicTimelineSection = buildTopicTimelineSection(sanitizedTopicTimeline);
  // Person Memory v1をここで初めてChat Contextへ接続する（今までは保存されるだけだった）。
  const sanitizedPersonView = sanitizePersonViewContext(personView);
  const personViewSection = buildPersonViewSection(sanitizedPersonView);

  const sanitizedProfile = sanitizeProfileContext(profile);
  const profileSection = buildProfileSection(sanitizedProfile);

  const systemInstruction = `${buildCurrentDateTimeContext()}\n${PERSONA_SYSTEM_PROMPT[persona] ?? PERSONA_SYSTEM_PROMPT.companion}\n${buildSharedSystemPrompt(searchNeeded)}${MEMORY_TIME_INSTRUCTIONS}${EVIDENCE_BOUNDARY_SECTION}${recentConversationSection}${topicContinuitySection}${topicTimelineSection}${personViewSection}${profileSection}${memoriesSectionForPersona}${webSearchInstruction}${recordFormatResetInstruction}`;

  // thinkingBudget floorの判定：retrievedMemories.lengthのような取得件数ではなく、
  // 実際にsystemInstructionへ渡ったsection（`retrievedMemoriesSection` / `recentConversationSection` /
  // `topicContinuitySection`。フィルタ等で最終的に空文字列になった場合は対象外）の有無を
  // 基準にする。全persona共通のsectionのため、companion/coach/analystいずれのターンでも
  // 同じ基準で最低budgetを保証する（persona別の特別扱いは今回追加しない）。Recent
  // Conversation・Topic Continuity Contextがあるターンも、Memoryがあるターンと同様に
  // 「継続の理解」に思考予算が要るため floor 512 とする。
  const thinkingBudget = computeThinkingBudget(latestUserMessage, {
    hasRetrievedMemories: retrievedMemoriesSection.length > 0,
    hasRecentConversation: recentConversationSection.length > 0,
    hasTopicContext: topicContinuitySection.length > 0,
  });

  // Test 13：記録形式のAIターンがあった場合、そのターンの実本文（Markdown記録）を
  // Geminiへ渡さない点はTest 12と同じだが、単純に除外するのではなく、同じ位置に
  // 内容を持たない短いダミーのassistantターンを差し込む。目的は、Geminiに渡る
  // 会話構造を「user→user」の異常な連続ではなく、通常の「user→model→user」の
  // 形に保ちつつ、記録本文そのものは見せないこと。ダミーターンには記録内容・
  // 固有名詞・会話的コメント・質問を一切含めない（会話構造の維持だけが目的）。
  // Test 26：この置換を「直前ターンのみ」から「記録形式に見える全てのAIターン」
  // へ拡張した（上のhasPreviousRecordTurnと同じ判定範囲の拡張）。通常の会話
  // ターンは対象外で、looksLikeRecordFormat()に一致したAIターンだけが対象。
  // Test 31：isProtectedRecordTurn()（isRecordTurn || looksLikeRecordFormat()）
  // を使い、生成時に確定したisRecordTurnも対象に含める。
  const RECORD_COMPLETION_PLACEHOLDER = "[記録依頼への応答は完了済み]";
  const providerTurns: { role: "user" | "ai"; content: string }[] = [];
  for (const turn of turns) {
    if (isProtectedRecordTurn(turn)) {
      providerTurns.push({ role: "ai", content: RECORD_COMPLETION_PLACEHOLDER });
      continue;
    }
    // Test 48：以前はここで「そのターンでWeb検索が有効でなかったAI turn（false/undefined）」
    // をProviderへ渡すcontextから除外していたが、これは通常の会話（Web検索を伴わない
    // 大多数のAI turn）で、AI自身の過去の発言そのものがGeminiから丸ごと見えなくなる
    // 副作用を持っていた（Test47で確認：ユーザーが実際に話した内容や、AI自身が直前の
    // ターンで答えた内容について「話していない」と否定するなど、会話履歴の認識が
    // 破綻する原因になっていた）。record保護turnを除き、user/ai turnは常にそのまま渡す。
    //
    // Time Axis Phase 1（Conversation Time Awareness）：以前はturn.timestampをここで
    // 捨てていたため、同一Conversation内に何日も前のturnが残っていても（例：閉じずに
    // 使い続けたタブ）、LLMにはそれを見分ける手段が無かった。Provider APIのmessage
    // schema自体（role/content構造）は変えず、contentの先頭にラベルとして付与する
    // （必要なければ何も付けない＝既存の見た目を壊さない）。
    const timestampLabel = formatTurnTimestampLabel(turn.timestamp);
    // 過去のAI発言の先頭に、モデルが出力した日時ラベルが保存されている場合は、先に取り除いてから、
    // 正しいラベルを1つだけ付ける（[日時]\n[日時]\n本文 という自己増幅を止める）。ユーザー発言は、
    // 本文の一部として意図的に書かれた日付表記かもしれないため、変更しない。保存済みのデータ自体は書き換えない。
    const baseContent = turn.role === "user" ? turn.content : stripLeadingTimeLabels(turn.content);
    const contentWithTimestamp = timestampLabel ? `${timestampLabel}\n${baseContent}` : baseContent;
    providerTurns.push({ role: turn.role === "user" ? "user" : "ai", content: contentWithTimestamp });
  }

  const provider = getProvider(providerName);
  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await provider.generateStream({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction,
      turns: providerTurns,
      // thinkingとレスポンス本文は同じmaxOutputTokensの枠を共有するため、
      // thinkingBudget（最大768）を差し引いても本文に十分な余裕が残る値にする。
      // 実機で「6行程度の日記」でも途中で切れる不具合があったため引き上げた。
      maxOutputTokens: 4096,
      providerOptions: { gemini: { thinkingBudget } },
      // provider非依存の要求フラグ（types.ts参照）。「GeminiならGoogle Search、OpenAIなら
      // OpenAI Web Search」のようなprovider分岐はここには作らない。各providerがこの
      // booleanをどう満たすかはそれぞれのadapter（gemini.ts/openai.ts）の責務。
      enableWebSearch: searchNeeded,
      abortSignal: request.signal,
    });
  } catch (error) {
    console.error("[Tsumugi Chat] generateContentStream failed:", error);

    // Beta C4：AIProviderErrorのtype（gemini.tsのnormalizeError／api-key/test/route.tsと同じ
    // 分類）を使い、APIキー由来のエラーだけ原因が分かるメッセージを返す。それ以外は
    // 従来通りの汎用メッセージ・502のまま（内部エラー詳細やAPIキー自体は返さない）。
    if (error instanceof AIProviderError && error.type === "auth") {
      return Response.json(
        { error: "APIキーが無効または期限切れの可能性があります。設定を確認してください。" },
        { status: 401 }
      );
    }

    return Response.json(
      { error: "Failed to start a response from the AI model." },
      { status: 502 }
    );
  }

  const encoder = new TextEncoder();

  // Conversation Debugger v1（開発専用）：`debugGenerationId`が無い通常リクエストでは
  // `debugEnvelope`は常にnullで、下のstart(controller)内の分岐へ一切入らない
  // （通常レスポンスはこの変更の前後でバイト単位で同一）。含めるのはPersonal Model
  // contextの動的部分（sanitize後、実際にsystemInstructionへ使われた値）だけ——
  // system prompt本文（persona固定文・共有prompt・Evidence Boundary本文）・API key・
  // その他secretは一切含めない。
  const debugEnvelope: GenerationDebugEnvelope | null = debugGenerationId
    ? {
        generationId: debugGenerationId,
        generation: {
          persona,
          provider: providerName,
          model: resolveModel(providerName),
          thinkingBudget,
          maxOutputTokens: 4096,
          searchNeeded,
        },
        serverAccepted: {
          recentConversation: recentConversation ?? null,
          profile: sanitizedProfile,
          personView: sanitizedPersonView,
          // buildTopicTimelineSection()はsanitizedTopicTimelineへさらに
          // selectTimelineEventsForBudget()（最古1件＋直近N-1件）を適用してから
          // systemInstructionへ載せる。「LLMが実際に見たcontext」を正確に反映するため、
          // ここでも同じ選択を適用する（sanitize結果そのままではない）。
          topicTimeline: sanitizedTopicTimeline.map((timeline) => ({
            topicId: timeline.topicId,
            events: selectTimelineEventsForBudget(timeline.events, TOPIC_TIMELINE_BUDGET.maxEventsPerTopic),
          })),
          // buildTopicContinuitySection()はmemories.length>0のtopicだけを使う。
          // 同じ絞り込みをここでも適用する。
          topicContinuity: topicContext
            ? topicContext.filter((t) => t.memories.length > 0).map((t) => ({ topicId: t.topicId, memories: t.memories }))
            : null,
          retrievedMemory: memoriesForContext,
        },
      }
    : null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // モデルが返答の先頭に日時ラベル（入力コンテキスト専用）を出力した場合は、ユーザーへ流す前に取り除く
      // （複数チャンクに分割されていても対応する。先頭以外は変更しない）。
      const labelStripper = new LeadingTimeLabelStripper();
      try {
        for await (const chunk of stream) {
          if (chunk.text) {
            const text = labelStripper.push(chunk.text);
            if (text) controller.enqueue(encoder.encode(text));
          }

          if (chunk.finishReason && chunk.finishReason !== "stop") {
            console.warn(`[Tsumugi Chat] stream finished with reason: ${chunk.rawFinishReason ?? chunk.finishReason}`);
          }
        }
        const tail = labelStripper.flush();
        if (tail) controller.enqueue(encoder.encode(tail));
        // Conversation Debugger v1：可視本文が全て流れ終わった後にだけ、区切り文字列＋
        // debug envelopeを追記する。区切り文字列はNUL文字を含み、Gemini出力に実質
        // 出現し得ないため、通常の可視本文と混同されない。クライアントは自分が
        // `debugGenerationId`を送った場合だけこの区切りを探す。
        if (debugEnvelope) {
          controller.enqueue(encoder.encode(DEBUG_ENVELOPE_DELIMITER + JSON.stringify(debugEnvelope)));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // このAIターンの生成で、Web検索が有効化されていたか（needsWebSearch()の判定結果）。
      // 実際に検索結果が取得できた・groundingが発生したことの証明ではない。
      // ストリーム本体（text/plain）にはメタデータを混ぜず、ヘッダーだけで伝える。
      "X-Tsumugi-Web-Search-Requested": String(searchNeeded),
      // Test 31：今回のAIターンが明示的な記録依頼への応答として生成されたか。
      // クライアントが新しいConversationTurnのisRecordTurnに保存する想定の
      // 実験用ヘッダー（本番機能ではない）。
      "X-Tsumugi-Is-Record-Turn": String(currentTurnIsRecordRequest),
    },
  });
}
