import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveApiKey, resolveModel, resolveRequestedProvider } from "@/lib/ai/resolve";

export const runtime = "nodejs";

/**
 * リアルタイム日記の本文（一日につき一つの会話を、終えたときに一度だけ）。会話全体から、その日の出来事・考え・その変化を自然な文章にする。
 * Memoryは作らない（Memoryは既存のCaptureが別に作る）。何も保存しない（保存はアプリ側が端末の記録へ）。
 * 送り先は、利用者が選んで要求が名指ししたAIだけ（PR #27の共通の仕組み。名指しが無ければ何も送らない）。
 */
const SYSTEM_PROMPT = `あなたはTsumugiという「Personal Memory OS」の一部として、
ユーザーが一日を通してTsumugiと話した会話（時刻付き）をもとに、その日の日記を書きます。

これは会話の要約ではなく、ユーザー本人の日記です。読み手は未来の本人です。
その日にあった出来事、考えたこと、気持ちや考えが一日の中でどう動いたかを、
後から読み返して思い出せる自然な文章にしてください。

文体：
- 常体（〜だった、〜した）。一人称は必須ではない
- 見出し・箇条書き・時刻の羅列は使わず、自然な日本語の文章にする。必要なら段落を分けてよい
- 時間の流れ（朝・昼・夜など）は、会話の時刻から分かる範囲で自然に織り込んでよい
- 質問はしない。その日の記録として完結させる

内容とgrounding（最重要）：
- ユーザー自身が会話の中で実際に語った出来事・考え・気持ちだけを書く
- 会話に無い出来事・感情・心情・状況・行動・決定・予定・情景を推測・補完・創作しない
- AI（Tsumugi）の発言は、ユーザーが語ったことを理解するための文脈としてだけ使う。
  AIが述べた推測や励まし・提案を、ユーザーの事実や気持ちとして書かない
- 「〜だったのだろう」「〜かもしれない」「〜することにしよう」のような、
  会話に無い推測・決意を表す言い回しを使わない
- 具体的な名前・場所・食べ物・作品・出来事・言葉など、読み返す価値のある具体は残す
- 分量は会話の情報量で決まる。短い会話なら短い日記でよい。水増ししない

titleについて：
- History一覧で見分けるための短い語句（目安10〜20文字）。その日の中心的な話題が分かるもの
- 「日記」「会話」という語、心理の分析・診断のような言い回し、文学的な比喩は使わない
- 本文と同じく、会話に無い意味・感情を足さない`;

const DIARY_SCHEMA: AISchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "History一覧で見分けるための短いタイトル（10〜20文字程度の語句）" },
    diary: { type: "string", description: "SYSTEM_PROMPTの指示に従った、その日の日記本文" },
  },
  required: ["title", "diary"],
};

/** 一日分の会話でも収まり、不正に大きな要求は断る上限（文字数） */
const MAX_CHARS = 200_000;

interface DiaryTurn { role: "user" | "ai"; content: string; time?: string }

export async function POST(request: Request) {
  const providerName = resolveRequestedProvider(request);
  if (!providerName) return Response.json({ error: "利用するAIが指定されていません。" }, { status: 400 });
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) return Response.json({ error: "APIキーが設定されていません。" }, { status: 401 });

  let body: { date?: unknown; turns?: unknown };
  try {
    body = (await request.json()) as { date?: unknown; turns?: unknown };
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  const turns = Array.isArray(body.turns)
    ? (body.turns as DiaryTurn[]).filter((t) => (t?.role === "user" || t?.role === "ai") && typeof t.content === "string" && t.content.trim() !== "")
    : [];
  if (!date || !turns.some((t) => t.role === "user")) return Response.json({ error: "date and turns are required" }, { status: 400 });

  const transcript = turns
    .map((t) => `${typeof t.time === "string" && t.time ? `[${t.time.slice(0, 16)}] ` : ""}${t.role === "user" ? "ユーザー" : "Tsumugi"}: ${t.content}`)
    .join("\n");
  if (transcript.length > MAX_CHARS) return Response.json({ error: "conversation too long" }, { status: 413 });
  const userContent = `日記の対象日: ${date}\n\n会話:\n${transcript}`;

  let response: { text: string };
  try {
    response = await getProvider(providerName).generateStructured({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: SYSTEM_PROMPT,
      userContent,
      maxOutputTokens: 4000,
      providerOptions: { gemini: { thinkingBudget: 512 } },
      schema: DIARY_SCHEMA,
    });
  } catch (error) {
    console.error("[Tsumugi Diary] generation failed:", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Failed to write the diary." }, { status: 502 });
  }

  let parsed: { title?: unknown; diary?: unknown };
  try {
    parsed = JSON.parse(response.text ?? "") as { title?: unknown; diary?: unknown };
  } catch {
    return Response.json({ error: "Failed to parse AI response as JSON." }, { status: 502 });
  }
  const diary = typeof parsed.diary === "string" ? parsed.diary.trim() : "";
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!diary) return Response.json({ error: "AI did not return a diary." }, { status: 502 });
  return Response.json({ diary, title });
}
