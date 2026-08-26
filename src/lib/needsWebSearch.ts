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
];

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
export function needsWebSearch(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const hasStrongTrigger = STRONG_TRIGGERS.some((word) => trimmed.includes(word));
  if (hasStrongTrigger) return true;

  const hasReferenceWord = REFERENCE_WORDS.some((word) => trimmed.includes(word));
  const hasFollowupWord = CURRENT_INFO_FOLLOWUP_WORDS.some((word) => trimmed.includes(word));
  if (hasReferenceWord && hasFollowupWord) return true;

  const hasWeakTrigger = NOW_PATTERN.test(trimmed) || WEAK_TRIGGERS.some((word) => trimmed.includes(word));
  if (!hasWeakTrigger) return false;

  const hasIntentMarker = INTENT_MARKERS.some((marker) => trimmed.includes(marker));
  return hasIntentMarker;
}
