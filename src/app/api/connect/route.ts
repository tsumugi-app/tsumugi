import type { LinkAxis } from "@/lib/types";
import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";

export const runtime = "nodejs";

const LINK_AXES: LinkAxis[] = ["person", "time", "theme", "emotion", "place"];

interface ConnectCandidateInput {
  id: string;
  date: string;
  summary: string;
  keywords: string[];
}

/**
 * MEMORY_ENGINE.md 2.3 Connect / 6章 Editing に対応する。
 * ここで行うのは「関連記憶の提示」ではなく、New MemoryとCandidatesの間に
 * 元々どちらにも書かれていなかった意味があるかどうかの判定と、その言語化のみ。
 * Entity（Theme/Person等）は一切扱わない（ROADMAP.md Phase 2、今回のスコープ外）。
 */
const SYSTEM_PROMPT = `あなたはTsumugiという個人向けAIプロダクトの記憶エンジン(Memory Engine)の一部として、
新しく生まれた記憶(New Memory)と、それに関連しそうな過去の記憶の候補(Candidates)を比較し、
意味のあるつながり(Link)を発見する「Connect」処理だけを担当します。あなたはユーザーとは会話しません。

役割:
- New MemoryとCandidatesの内容を比較し、単なる話題の一致ではなく、
  "元々どちらにも書かれていなかった意味"が生まれる組み合わせだけを見つける
- 見つかった場合、なぜその2つが今つながるのかを、両方の記憶の具体的な内容を参照しながら言語化する(reason)
- そのつながりが「継続」「変化」「対照」のどれに近いかを意識する

厳守事項:
- reasonは必ず両方の記憶の具体的な内容を参照すること。
  「どちらも○○についての話です」のような要約・言い換えだけで終わらせてはならない
- 断定は避け、「〜のようです」「〜なのかもしれません」のような仮説として提示する
- 実際に書かれていない事実を作り出さない
- 弱い根拠、表面的なキーワード一致だけの組み合わせは無理にLinkにしない。
  該当するCandidateが無ければ、linksは空配列で返してよい(これは失敗ではない)
- strengthは確信度を正直に0〜1で示す。自信が無ければ低い値にする
- 1つのCandidateにつき、Linkは最大1つ`;

function buildPrompt(
  newMemory: { summary: string; content: string; keywords: string[] },
  candidates: ConnectCandidateInput[]
): string {
  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i + 1}. id: ${c.id}\n   日付: ${c.date.slice(0, 10)}\n   要約: ${c.summary}\n   キーワード: ${c.keywords.join(", ") || "なし"}`
    )
    .join("\n\n");

  return `## New Memory\n要約: ${newMemory.summary}\n内容: ${newMemory.content}\nキーワード: ${newMemory.keywords.join(", ") || "なし"}\n\n## Candidates\n${candidateLines}`;
}

/** capture/route.tsと同じ理由でthinking予算を明示する。候補数・本文量が多いほど予算を増やす。 */
function computeThinkingBudget(promptLength: number): number {
  if (promptLength < 500) return 256;
  if (promptLength < 1500) return 512;
  return 1024;
}

const LINKS_SCHEMA: AISchema = {
  type: "object",
  properties: {
    links: {
      type: "array",
      description: "意味のあるつながりが見つかったCandidateのみ。無ければ空配列。",
      items: {
        type: "object",
        properties: {
          candidateId: {
            type: "string",
            description: "対象となるCandidateのid",
          },
          axis: {
            type: "string",
            enum: LINK_AXES,
            description: "このつながりが最も近い軸",
          },
          reason: {
            type: "string",
            description: "なぜ今この2つがつながるのかの具体的な言語化",
          },
          strength: {
            type: "number",
            description: "つながりの確からしさ(0〜1)",
          },
          contrast: {
            type: "boolean",
            description: "一致ではなく対照によるつながりかどうか",
          },
        },
        required: ["candidateId", "axis", "reason", "strength", "contrast"],
      },
    },
  },
  required: ["links"],
};

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("connect");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json(
      { error: "Gemini APIキーが設定されていません。" },
      { status: 401 }
    );
  }

  const { newMemory, candidates } = (await request.json()) as {
    newMemory: { summary: string; content: string; keywords: string[] };
    candidates: ConnectCandidateInput[];
  };

  if (!newMemory || !candidates || candidates.length === 0) {
    return Response.json({ error: "newMemory and candidates are required" }, { status: 400 });
  }

  const prompt = buildPrompt(newMemory, candidates);

  const provider = getProvider(providerName);
  let response: { text: string };
  try {
    response = await provider.generateStructured({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: SYSTEM_PROMPT,
      userContent: prompt,
      providerOptions: { gemini: { thinkingBudget: computeThinkingBudget(prompt.length) } },
      schema: LINKS_SCHEMA,
    });
  } catch (error) {
    console.error("[Tsumugi Connect] generateContent failed:", error);
    return Response.json(
      { error: "Failed to generate a connect judgment from the AI model." },
      { status: 502 }
    );
  }

  const text = response.text;
  if (!text) {
    return Response.json(
      { error: "AI did not return a structured connect result." },
      { status: 502 }
    );
  }

  try {
    const parsed = JSON.parse(text);
    return Response.json(parsed);
  } catch {
    return Response.json({ error: "Failed to parse AI response as JSON." }, { status: 502 });
  }
}
