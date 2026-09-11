/**
 * `/api/chat`が、そのターンで送るユーザーの直近発言だけを見て「現在のWeb情報が必要そうか」を
 * ローカルに判定するための最小限のヒューリスティック。AIは一切呼ばない
 * （`retrieval.ts`の`isReflectiveQuery()`と同じ設計方針：完璧な意図判定はできない前提で、
 * 誤検出は許容する）。
 *
 * Geminiの`google_search`はAPI仕様上アプリ側から強制発火させられない（モデル自身の自律判断）。
 * この関数の役割は「検索を強制すること」ではなく、「そのターン専用の強い検索指示を
 * systemInstructionへ追加すべきかどうか」をroute.ts側が判断するための材料を作ることに限る。
 *
 * 単純な語の存在チェックだけでは、「今日は仕事で疲れた」のような、時間語を含むだけの
 * 日常的な発言まで拾ってしまう。そこで語を2段階に分ける。
 *
 * - STRONG_TRIGGERS：単独で現在の外部情報を尋ねていると判断してよい語
 *   （価格・在庫・営業状況・天気等、それ自体が「今の状態」を指す語）
 * - WEAK_TRIGGERS：時間・将来・外出・場所を表すが、それだけでは日常会話にも出現する語
 *   （今・現在・今日・次・お店・行ける等）。これらは、発言全体が「質問・要求」の形を
 *   取っているとき（INTENT_MARKERSのいずれかを含むとき）に限り、検索が必要と判定する。
 *
 * これに加えて、直前の会話で検索した対象を代名詞で受けて追加質問するケース
 * （「それ何時から？」等）を別枠で拾う。この関数自身は「それ」が何を指すかを解決しない
 * （会話状態・Conversation型は一切参照しない）。あくまで「代名詞＋現在情報を尋ねる語」という
 * 表層パターンから、外部情報の確認が必要になり得る発言かどうかだけを判定する。実際に
 * 「それ」が何を指すか・何を検索するかはAIモデルが会話履歴から判断する。
 *
 * 過去の出来事の相談、Memory/Tsumugi自体についての相談、一般的な知識の質問、創作の依頼などは、
 * これらの語を含まない限り自然にfalseになる（個別の除外リストは持たない）。
 *
 * 例外として一つだけ、会話状態を最小限参照する。「この人のこと教えて」のように、latestUserMessage
 * 自身には対象の固有名詞が無く、指示語（この人・この会社・それ等）で直前の対象を参照しながら
 * 外部事実を求めている発言は、latestUserMessage単体では誰・何についてか解決できない。この場合に
 * 限り、呼び出し側（route.ts）から「今のConversationに、今回のユーザー発言より前のturnsが
 * 存在するか」という1個のbooleanだけを受け取り、それが無ければ（＝新規Conversationでの単発の
 * 発言）検索対象にしない（対象を特定できないまま検索させない。Recent Conversationや Retrieved
 * Memoriesはここでは一切参照しない）。
 */

const STRONG_TRIGGERS = [
  "最新",
  "最新の",
  "天気",
  "営業時間",
  "営業状況",
  "営業",
  "開催日時",
  "発売",
  "販売中",
  "予約",
  "在庫",
  "価格",
  "値段",
  "現在の価格",
  // 商品・作品・イベント等の「新しさ／すでに世に出たこと」を指す語。名称だけから内容を
  // 推測して「知っている」ように話すのを防ぐため、これ単独でも現在の外部情報が必要と判定する。
  "新型",
  "新作",
  "新製品",
  "新モデル",
  "リニューアル",
  "発表された",
  "発表され",
  "発売された",
  "公開された",
  "開催された",
  "リリースされ",
  "もう発表",
  "もう発売",
  "もう公開",
  "もう出た",
  "既に発売",
  "すでに発売",
  // 明示的な検索要求。これ自体が「AIの内部知識ではなく外部で確認してほしい」という合図。
  "調べて",
  "調べてみて",
  "調べ直し",
  "検索して",
  "ぐぐって",
  "ググって",
  "確認して",
  "確認してみて",
  "見てみて",
  "ちゃんと調べ",
  "もう一度調べ",
  // 現在価格・中古相場を尋ねる語（それ自体が「今いくら」を指す）。
  "中古価格",
  "中古相場",
  "いくらくらい",
  "いくらぐらい",
  "おいくら",
];

const WEAK_TRIGGERS = [
  "現在",
  "今日",
  "明日",
  "明後日",
  "今週",
  "今週末",
  "来週",
  "最近",
  "直近",
  "今月",
  "今季",
  "次",
  "後で",
  "店舗",
  "お店",
  "行ける",
  "買える",
  "旅行",
  "デート",
  "外出",
  "イベント",
  // 現在性を示すが日常会話にも出る語。質問・要求の形（INTENT_MARKERS）を伴うときだけ検索を要すると判定する。
  "新しい",
  "今度",
  "今年",
  "去年",
  "昨年",
  "中古",
  "相場",
  "安くなって",
  "値下がり",
  "値下げ",
  "現行モデル",
  "現行機",
  "ラインナップ",
];

/**
 * 特定の実在人物・会社・製品について「それが何者か／どこか／いくらか／存在するか」という
 * 具体的な外部事実を尋ねる語。INTENT_MARKERSを伴うときに検索を要すると判定する。
 * 「中野優作が気になる」「サイサリスかっこいい」のように固有名詞が出るだけでは当たらず、
 * 「中野優作ってなんの人？」「今どこの会社？」「このスマホいくら？」のような具体的な
 * 外部事実の要求のときだけ拾う。
 */
const EXTERNAL_FACT_QUERY_MARKERS = [
  "なんの人",
  "何の人",
  "なにしてる人",
  "何してる人",
  "何者",
  "どこの会社",
  "どこ所属",
  "現在の役職",
  "今の役職",
  "何て会社",
  "発売されてる",
  "発売してる",
  "もう出てる",
  "まだ出てる",
  "存在する",
];

/**
 * 「この人」「この会社」等、直前の対象を指示語で受けている語。これ単独では検索対象にせず、
 * EXTERNAL_FACT_REQUEST_VERBSと組み合わさり、かつ会話に前turnsが存在するときだけ使う。
 */
const REFERENCE_TARGET_MARKERS = [
  "この人",
  "このひと",
  "この人物",
  "この方",
  "この会社",
  "この企業",
  "この製品",
  "この商品",
  "この機種",
  "このモデル",
  "こいつ",
  "それ",
  "あれ",
];

/**
 * 対象の外部事実（経歴・所属・詳細）を説明してほしいという要求そのものを表す語。
 * EXTERNAL_FACT_QUERY_MARKERSで拾いきれない、より一般的な「教えて」「知ってる？」
 * 「詳しく知りたい」等の言い方をここに持つ。
 */
const EXTERNAL_FACT_REQUEST_VERBS = [
  "教えて",
  "詳しく知りたい",
  "経歴は",
  "知ってる",
  "知ってます",
  "どんな会社",
  "どういう会社",
  "どんな人",
  "どういう人",
  "どんな製品",
  "どういう製品",
  "どんな機種",
  "どういう機種",
];

/**
 * 対象が同じ発言内に直接書かれていて（指示語の解決も、会話の前turnsも必要としない）、かつ
 * 明確に説明・外部事実を求めている言い方。「について」「って」で対象を受けたあと、教えて・
 * 詳しく・どんな等の明確な説明要求が続く場合だけ拾う。「◯◯について」「◯◯が気になる」の
 * ように話題を提示しただけで止まる発言はここに当たらない（REFERENCE_TARGET_MARKERS＋
 * EXTERNAL_FACT_REQUEST_VERBSの組み合わせと違い、指示語も前turnsも不要＝latestUserMessage
 * 単体で解決できるため、下のcheckは単独で成立する）。
 */
const EXPLICIT_EXPLANATION_REQUEST_MARKERS = [
  "について教えて",
  "についてもっと教えて",
  "について詳しく",
  "ってどんな人",
  "ってどういう人",
  "って何してる人",
  "ってなにしてる人",
  "ってどんな会社",
  "ってどういう会社",
  "ってどんな製品",
  "ってどういう製品",
  "ってどんな機体",
  "ってどういう機体",
  "設定上どんな",
  "詳しく知りたい",
];

/**
 * ユーザーが「現在、具体的な型番の製品が存在する／現行である」と主張している表現。
 * 型番の言及そのもの（「15T使ってる」等）だけでは当たらず、存在・現行であることを
 * 主張する言い方（「今17Tあるじゃん」「もう出てるよ」「現行だよね」等）と型番らしい語
 * （数字＋英字、または英字＋数字）が両方そろったときだけ、内部知識だけで真偽を
 * 断定させず検索対象にする。
 */
const CURRENT_LINEUP_ASSERTION_MARKERS = [
  "あるじゃん",
  "あるよね",
  "出てるじゃん",
  "出てるよ",
  "現行だよね",
  "現行でしょ",
  "現行じゃん",
];

/** 型番らしい語（「17T」「15T」「Pro3」等、数字と英字が連続する短い語）。 */
const MODEL_TOKEN_PATTERN = /[0-9０-９]+[A-Za-zＡ-Ｚａ-ｚ]+|[A-Za-zＡ-Ｚａ-ｚ]+[0-9０-９]+/;

/**
 * 「特定の作品・商品・イベント・企画の、具体的な一実施・一巻・一回」を指す語。
 * 一般的な対象への雑談（「ハンターハンターってどう思う？」「ガンダムで一番好きなMSは？」）には
 * 出ず、「39巻の渋谷ジャック」「昨日のイベント」「このキャンペーン」のような具体性のある
 * 質問にだけ出る。これ＋INTENT_MARKERS（質問・評価要求の形）のときに、その企画・巻の
 * 実際の内容を尋ねている可能性が高いと判断し、名称から中身を推測させず検索を優先する。
 * 「この前の彼女の話」のような Recent Conversation / Topic 的な言及は、これらの語を含まないため
 * 誤検出しない（「こないだ」「この前」等の時間語自体はここでもWEAK_TRIGGERSでも扱わない）。
 */
const SPECIFIC_INSTANCE_MARKERS = [
  "コラボ",
  "キャンペーン",
  "フェア",
  "ジャック", // 「渋谷ジャック」「駅ジャック」等の広告・空間ジャック企画
  "新刊",
  "最新刊",
  "新曲",
  "新譜",
  "新番組",
  "特番",
  "催し",
  "原画展",
];

/** 数字＋巻/話/号/期/章（「39巻」「最終話」ではなく数字前提。「この前の話」等は数字が無いので当たらない）。 */
const NUMBERED_INSTALLMENT_PATTERN = /[0-9０-９]+\s*[巻話号期章]/;

/**
 * ユーザーがAIの述べた事実を訂正しているらしい短い発言（「それ違うよ」「全然違う」
 * 「AじゃなくてBだよ」等）。会話履歴は参照しないが、こうした短い訂正は多くの場合
 * 「AIの古い知識・推測が現実と食い違っている」合図なので、Webで確認可能な話題であれば
 * 推測で会話を続けず確認してから戻れるよう、検索を要すると判定する。
 * 「私の気持ちとは全然違う」等の長文中の語まで拾わないよう、短い発言のときだけ適用する。
 * （「もう発表されたよ」等は上のSTRONG_TRIGGERS側で拾う。）
 */
const CORRECTION_MARKERS = [
  "違うよ",
  "違います",
  "じゃなくて",
  "じゃなく",
  "そうじゃなく",
  "そうじゃない",
  "間違って",
  "間違い",
  "全然違",
  // AIの「存在する／した」という前提への訂正（「16Tなんて出てないけど」「そんなの無い」）
  "なんて出て",
  "なんてない",
  "そんなの無い",
  "そんなのない",
  "存在しない",
  "その人じゃない",
];
const CORRECTION_MAX_LEN = 18;

/**
 * 「今」は「現在」を表す語として拾いたいが、「今回」のような別の意味の語には反応させない。
 * 単純な部分一致（`includes("今")`）ではこの区別ができないため、「今」の直後に「回」が
 * 続く場合だけを除外する正規表現で判定する（「今日」「今週」等は別途WEAK_TRIGGERSの
 * 個別の語として持っているため、ここでは「今」単体の扱いだけを担う）。
 */
const NOW_PATTERN = /今(?!回)/;

/**
 * WEAK_TRIGGERSと組み合わさったときだけ「質問・要求」らしさの補強材料として使う。
 * "たい"は"したい"「〜を考えたい」のような一般語にも部分一致してしまうため単独では使わず、
 * 意図が明確な複合語（"知りたい"等）に限定する。
 */
const INTENT_MARKERS = [
  "？",
  "?",
  "知りたい",
  "調べたい",
  "確認したい",
  "見たい",
  "欲しい",
  "教えて",
  "かな",
  "だろう",
  "かしら",
  "ですか",
  "ますか",
];

/** 直前の会話で検索した対象を受ける代名詞。この関数自身は指示対象を解決しない。 */
const REFERENCE_WORDS = ["それ", "あれ", "そこ"];

/**
 * REFERENCE_WORDSと組み合わさったときだけ、現在情報の追加確認だと判定する語。
 * 代名詞単体では「それについてどう思う？」のような検索不要な質問まで拾ってしまうため、
 * 現在の状態・時刻・場所を尋ねる語との組み合わせのときだけtrueにする。
 */
const CURRENT_INFO_FOLLOWUP_WORDS = ["何時", "いつ", "どこ", "予約"];

/**
 * このユーザー発言に対して、そのターン専用のWeb検索指示をsystemInstructionへ
 * 追加すべきかを判定する。会話履歴やConversationの状態は一切参照しない
 * （毎ターン、渡された文字列単体だけで再計算する）。
 */
export function needsWebSearch(text: string, hasPriorConversationContext = false): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const hasStrongTrigger = STRONG_TRIGGERS.some((word) => trimmed.includes(word));
  if (hasStrongTrigger) return true;

  if (trimmed.length <= CORRECTION_MAX_LEN && CORRECTION_MARKERS.some((word) => trimmed.includes(word))) {
    return true;
  }

  // 対象が同じ発言内に直接書かれた状態で、明確に説明・外部事実を求めている
  // （「について」「気になる」だけで止まる話題提示とは区別する）。指示語の解決も
  // 会話の前turnsも不要なため、単独で検索対象と判定してよい。
  if (EXPLICIT_EXPLANATION_REQUEST_MARKERS.some((word) => trimmed.includes(word))) {
    return true;
  }

  const hasReferenceWord = REFERENCE_WORDS.some((word) => trimmed.includes(word));
  const hasFollowupWord = CURRENT_INFO_FOLLOWUP_WORDS.some((word) => trimmed.includes(word));
  if (hasReferenceWord && hasFollowupWord) return true;

  const hasIntentMarker = INTENT_MARKERS.some((marker) => trimmed.includes(marker));

  // 実在人物・会社・製品について「何者か／どこか／存在するか」という具体的な外部事実を尋ねている。
  const hasExternalFactQuery = EXTERNAL_FACT_QUERY_MARKERS.some((word) => trimmed.includes(word));
  if (hasExternalFactQuery && hasIntentMarker) return true;

  // 「この人／それ等の指示語」＋「教えて／知ってる？等の外部事実の要求」＝latestUserMessage
  // 単体では対象を解決できないが、外部事実を求めている。会話に前turnsが無ければ（新規
  // Conversationでの単発発言）対象を特定できないため検索対象にしない。
  const hasReferenceTarget = REFERENCE_TARGET_MARKERS.some((word) => trimmed.includes(word));
  const hasExternalFactRequest =
    hasExternalFactQuery || EXTERNAL_FACT_REQUEST_VERBS.some((word) => trimmed.includes(word));
  if (hasReferenceTarget && hasExternalFactRequest && hasPriorConversationContext) return true;

  // 「型番らしい語」＋「現在存在する／現行だと主張する言い方」＝ユーザーが現在のラインナップの
  // 存在を主張している。型番の言及だけ（「15T使ってる」）ではここを通らない。
  const hasCurrentLineupAssertion = CURRENT_LINEUP_ASSERTION_MARKERS.some((word) => trimmed.includes(word));
  if (hasCurrentLineupAssertion && MODEL_TOKEN_PATTERN.test(trimmed)) return true;

  // 「特定の巻・企画・キャンペーン等」＋「質問・評価要求の形」＝その実際の内容を尋ねている
  // 可能性が高い。一般的な対象への雑談（SPECIFIC_INSTANCE_MARKERSを含まない）はここを通らない。
  const hasSpecificInstance =
    NUMBERED_INSTALLMENT_PATTERN.test(trimmed) || SPECIFIC_INSTANCE_MARKERS.some((word) => trimmed.includes(word));
  if (hasSpecificInstance && hasIntentMarker) return true;

  const hasWeakTrigger = NOW_PATTERN.test(trimmed) || WEAK_TRIGGERS.some((word) => trimmed.includes(word));
  if (!hasWeakTrigger) return false;

  return hasIntentMarker;
}
