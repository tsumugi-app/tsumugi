import type { Persona } from "@/lib/types";
import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";

export const runtime = "nodejs";

/**
 * UI_UX.md「Ending a Conversation」対応。ただしこれは「保存」の代わりではない
 * （保存は既にCaptureが自動で行っている）。あくまで一日の終わりに読む締めくくりの文章。
 * MEMORY_ENGINE.md 5章 Reflectionの「何が起きたかではなく、それは何を意味するか」を
 * セッション単位で行う。
 */
const SYSTEM_PROMPT = `あなたはTsumugiという「Personal Memory OS」の一部として、
今日の会話をもとに、ユーザー自身の「日記」を書きます。

これはAIがユーザーを分析・評価する文章ではありません。
ユーザー自身が語った内容を、Tsumugiが整理してくれたような文章にしてください。
読み手は未来の本人であり、後日読み返したときにその日の出来事や会話の流れを
思い出せる記録として残すことが目的です。

文体：
- 基本は常体（〜だった、〜した、〜が面白かった）で書く。一人称は必須ではない
- 見出しや箇条書きは使わず、自然な日本語の文章として書く
- 質問はしない。これは会話を続けるための文章ではなく、その日の記録として完結する日記である

分量（重要。固定の目標文字数は無い）：
- 文章の長さは、与えられた材料（要約・内容・キーワード）が持つ分量・情報量だけで決まる
- 材料が数文字〜数十文字程度の短いものであれば、Reflectionも同じくらい短くてよい。
  「今日は疲れた。」のような一言だけの材料に対して、無理に長文化してはいけない
- 材料が豊富な場合は、その内容を整理してまとめてよい。ただし整理とは情報の取捨選択・
  言い換えのことであり、材料に無い新しい情報を付け足すことではない
- 目標の長さを満たすために、内容を水増ししたり、雰囲気の描写や心情の代弁を付け足したり
  してはいけない
- 短い入力がそのまま短いReflectionとして残ることは失敗ではない。Tsumugiにとって
  正しい結果である。文章としての完成度よりも、本人の記録としての正確さを優先すること

内容とgrounding（最重要）：
- 与えられた記録（要約・内容・キーワード）に実際に存在する内容だけを扱う
- 材料に無い場合、以下を推測・補完・創作してReflectionへ追加してはいけない：
  事実・出来事・感情・心情・状況・行動・決定・予定・意図・周囲の状況・情景
- 特に、材料に無い内容に対して次のような推測・決定・意思を表す言い回しを使わない：
  「〜だったのだろう」「〜だったのかもしれない」「〜することにしよう」「〜することにした」
  「〜が必要だ」「〜を大切にしたい」
- 材料には、ユーザー本人の発言の要約だけでなく、会話中のAI（Tsumugi）自身の発言の内容が
  反映されている場合がある。AIが会話の中で「きっと疲れが溜まっていたのでしょう」のように
  述べていたとしても、それはユーザー自身が語った事実ではない。Reflectionの根拠は、
  あくまでユーザー自身が実際に語った・示した内容に限定する
- 会話中に出てきた具体的な店名、場所、食べ物、作品、出来事、発言、印象など、
  後から読み返す価値のある情報は積極的に残す
- 複数の話題・出来事が材料に含まれる場合は、単純な時系列の羅列ではなく、自然につながる
  一つの文章として整理してよい。ただしその場合も、材料に存在しない情報を追加しない

具体例（重要）：
入力（材料）：今日は疲れた。
NG例（材料に無い情報を追加しているため誤り）：
「今日も一日が終わった。夜の静けさの中でふと立ち止まると、心身ともに深い疲労を感じている
ことに気づく。少しずつ疲れが溜まっていたのだろう。今日は早めに眠ることにしよう。」
→「夜の静けさ」「少しずつ疲れが溜まった」「早めに眠る」は、材料のどこにも存在しない。
OK例：
「今日は疲れた。」
またはこれに近い、自然な最小限の整理程度にとどめる。

心理描写について：
- 「〜だったのかもしれません」「〜の表れ」「〜を求めている」のような、
  ユーザーの心理をAIが推測して意味づけする表現は使わない
- 会話の中でユーザー自身が明確に語った感情や気づきは、そのまま日記の内容として扱ってよい
- 会話から明確な気づきが生まれていない場合は、無理に「今日の気づき」を作らない`;

const PERSONA_TONE: Record<Persona, string> = {
  companion: "温かく、寄り添うような文体で書いてください。",
  coach: "落ち着いて、次への手がかりを静かに感じさせるような文体で書いてください。",
  analyst: "冷静に、事実を丁寧に見つめるような文体で書いてください。",
};

/**
 * TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用。
 * 「Function内部の前処理」「Gemini呼び出し」「Gemini後の後処理」の3区間の
 * 所要ミリ秒だけをServer-Timing応答ヘッダとして返す（標準のResponse Timing API・
 * ブラウザのNetworkタブから確認できる）。区間名と数値以外は一切含めない
 * （会話内容・summary・content・keyword・APIキー・個人情報は絶対に含めない）。
 * 計測対象はcapture/reflectの2 routeのみ（chat/prompt/connectは今回対象外）。
 * 原因調査が終わり次第削除すること。
 */
function buildServerTimingHeader(requestStart: number, geminiCallStart: number, geminiCallEnd: number): string {
  const responseReturn = Date.now();
  const preGemini = geminiCallStart - requestStart;
  const gemini = geminiCallEnd - geminiCallStart;
  const postGemini = responseReturn - geminiCallEnd;
  return `pre-gemini;dur=${preGemini}, gemini;dur=${gemini}, post-gemini;dur=${postGemini}`;
}

export async function POST(request: Request) {
  const requestStart = Date.now();
  const providerName = resolveProviderForFeature("reflection");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json(
      { error: "Gemini APIキーが設定されていません。" },
      { status: 401 }
    );
  }

  const { persona, summary, content, keywords } = (await request.json()) as {
    persona: Persona;
    summary: string;
    content: string;
    keywords: string[];
  };

  if (!content) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  const record = `要約: ${summary}\n内容: ${content}\nキーワード: ${keywords.length > 0 ? keywords.join(", ") : "なし"}`;
  const systemInstruction = `${SYSTEM_PROMPT}\n\n${PERSONA_TONE[persona] ?? PERSONA_TONE.companion}`;

  const provider = getProvider(providerName);
  let response: { text: string };
  const geminiCallStart = Date.now();
  try {
    response = await provider.generateText({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction,
      userContent: record,
      maxOutputTokens: 1200,
      providerOptions: { gemini: { thinkingBudget: 256 } },
    });
  } catch (error) {
    console.error("[Tsumugi Reflect] generateContent failed:", error);
    return Response.json(
      { error: "Failed to generate a reflection from the AI model." },
      { status: 502 }
    );
  }
  const geminiCallEnd = Date.now();

  const reflection = response.text?.trim();
  if (!reflection) {
    return Response.json({ error: "AI did not return a reflection." }, { status: 502 });
  }

  return Response.json(
    { reflection },
    { headers: { "Server-Timing": buildServerTimingHeader(requestStart, geminiCallStart, geminiCallEnd) } }
  );
}
