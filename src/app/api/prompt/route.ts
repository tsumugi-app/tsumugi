import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import { buildRevisitPromptRecord } from "@/lib/revisitPromptSafety";

export const runtime = "nodejs";

/**
 * Beta「過去からの問いかけ」機能。トップ画面を開いた瞬間に、Tsumugiが過去のMemory 1件を
 * もとに短い問いかけを1つ作る。Tsumugiが過去を覚えていることを最初に体験してもらうための
 * ものであり、そのために過去の情報を創作してはいけない（groundingがReflectionと並ぶ最重要事項）。
 */
const SYSTEM_PROMPT = `あなたはTsumugiという「Personal Memory OS」の一部として、
過去に保存された1件のMemory（記憶）をもとに、ユーザーへの短い問いかけを1つ作ります。

これは、Tsumugiが過去の記憶を覚えていることを、ユーザーが画面を開いた瞬間に
自然に感じられるようにするための機能です。ただし、覚えていることを示すために
Memoryに書かれていない内容を作り出してはいけません。

目的：
「以前話していた〇〇。あれからどうですか？」のように、
Memoryの内容そのものについて、その続きを自然に尋ねる、短い問いかけを1つ作る。

時間表現（最重要・絶対に守ること）：
この問いかけは保存され、後日（何日後・何週間後かは分からない）そのまま表示される。
そのため、表示する日によって意味が変わる相対的な時間表現は一切使わない。
- 使ってはいけない例：「昨日」「今日」「明日」「明後日」「先週」「今週」「来週」
  「この前」「最近」「先日」「きのう」「きょう」「あした」
- Memoryの要約・内容に「昨日」「先週」などが書かれていても、その言葉を問いかけに
  持ち込まない（それは記録した時点から見た表現であり、表示する日には意味が変わる）。
- 入力には「記録日」と「出来事日時」が別の行として与えられる。記録日はTsumugiに保存された
  日であり、出来事が起きた日とは限らない。出来事の日時を、記録日から推測しない。
- 出来事日時が「日精度」で与えられている場合だけ、その日付を「2026年9月16日」のような
  絶対日付で書いてよい。「月精度」なら「2026年9月」まで、「年精度」なら「2026年」まで
  にとどめ、与えられていない精度（日や月）を補わない。
- 出来事日時が「不明」の場合は、日付・時期を一切書かず、「以前話していた〇〇」のように
  時期を特定しない言い方にする。

grounding（最重要・絶対に守ること）：
与えられたMemory（要約・内容・キーワード）に実際に書かれている内容だけを扱う。
以下のような、Memoryに書かれていない結果・感情・状況・行動・予定を前提にした
問いかけを作ってはいけない：
- 「少し形になってきましたか？」→「形になった」という前提がMemoryに無いため禁止
- 「忙しい中でも考える時間は取れましたか？」→「忙しい」という情報がMemoryに無いため禁止
- 「うまくいきましたか？」→「うまくいくこと」を前提にしているため禁止
- 「その後、誰かに相談しましたか？」→ 相談した可能性を根拠なく作っているため禁止
このように、Memoryに書かれていない前提を問いの中に混ぜ込まない。

良い例：
Memory：「新しいアプリのアイデアについて考えていた。」（出来事日時：不明）
→「以前話していた新しいアプリのアイデア。あれからどうですか？」
→「以前話していた新しいアプリのアイデア、その後何か変わりましたか？」

Memory：「公園を散歩した。」（出来事日時：2026-09-16、日精度）
→「2026年9月16日の散歩について、あれからどうですか？」

形式：
- 1〜2文程度。短く簡潔に
- 文学的な表現、情景描写、心情の代弁はしない
- アドバイスをしない。励まさない
- ユーザーが自由に答えられる、開いた問いにする
  （基本形：「その後どうですか？」「何か変わりましたか？」）
- ただし毎回同じ文にせず、Memoryの内容（具体的な話題）に応じて言葉を自然に変える
- 「そういえば、以前話していた」のような前置きは付けてもよいが必須ではない
- ユーザーに返すのは問いかけの本文だけにする。前置きの説明や解説を付けない`;

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("revisitPrompt");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json(
      { error: "Gemini APIキーが設定されていません。" },
      { status: 401 }
    );
  }

  const { summary, content, keywords, date, eventTime, eventTimePrecision } = (await request.json()) as {
    summary: string;
    content: string;
    keywords: string[];
    /** 記録日（Memory.date）。出来事日時とは別の情報として扱う。 */
    date?: string;
    eventTime?: string;
    eventTimePrecision?: string;
  };

  if (!content) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  const record = buildRevisitPromptRecord({
    summary,
    content,
    keywords: Array.isArray(keywords) ? keywords : [],
    date,
    eventTime,
    eventTimePrecision,
  });

  const provider = getProvider(providerName);
  let response: { text: string };
  try {
    response = await provider.generateText({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: SYSTEM_PROMPT,
      userContent: record,
      maxOutputTokens: 200,
      providerOptions: { gemini: { thinkingBudget: 128 } },
    });
  } catch (error) {
    console.error("[Tsumugi Prompt] generateContent failed:", error);
    return Response.json(
      { error: "Failed to generate a top prompt from the AI model." },
      { status: 502 }
    );
  }

  const question = response.text?.trim();
  if (!question) {
    return Response.json({ error: "AI did not return a question." }, { status: 502 });
  }

  return Response.json({ question });
}
