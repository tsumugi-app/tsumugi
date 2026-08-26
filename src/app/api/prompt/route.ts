import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";

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
「そういえば、先日話していた〇〇。あれからどうですか？」のように、
Memoryの内容そのものについて、その続きを自然に尋ねる、短い問いかけを1つ作る。

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
Memory：「新しいアプリのアイデアについて考えていた。」
→「そういえば、先日話していた新しいアプリのアイデア。あれからどうですか？」
→「先日話していた新しいアプリのアイデア、その後何か変わりましたか？」

形式：
- 1〜2文程度。短く簡潔に
- 文学的な表現、情景描写、心情の代弁はしない
- アドバイスをしない。励まさない
- ユーザーが自由に答えられる、開いた問いにする
  （基本形：「その後どうですか？」「何か変わりましたか？」）
- ただし毎回同じ文にせず、Memoryの内容（具体的な話題）に応じて言葉を自然に変える
- 「そういえば、先日話していた」のような前置きは付けてもよいが必須ではない
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

  const { summary, content, keywords } = (await request.json()) as {
    summary: string;
    content: string;
    keywords: string[];
  };

  if (!content) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  const record = `要約: ${summary}\n内容: ${content}\nキーワード: ${keywords.length > 0 ? keywords.join(", ") : "なし"}`;

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
