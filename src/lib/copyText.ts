/**
 * 文字列をクリップボードへコピーする（表示・コピー専用）。成功したときだけtrue。
 * navigator.clipboard（HTTPSのAndroid Chrome等）を先に使い、無い・拒否されたときは選択してのコピー（execCommand）を試す。
 * どちらも成功を確認できなければfalse（呼び出し側は成功と表示しない）。
 */
export interface CopyEnv {
  navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
  document?: Pick<Document, "createElement" | "execCommand" | "body">;
}

const realEnv = (): CopyEnv => ({
  navigator: typeof navigator !== "undefined" ? navigator : undefined,
  document: typeof document !== "undefined" ? document : undefined,
});

export async function copyText(text: string, env: CopyEnv = realEnv()): Promise<boolean> {
  try {
    const writeText = env.navigator?.clipboard?.writeText;
    if (typeof writeText === "function") {
      await writeText.call(env.navigator?.clipboard, text);
      return true;
    }
  } catch {
    // fall through to the selection copy
  }
  const doc = env.document;
  if (!doc || !doc.body) return false;
  try {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    try {
      area.select();
      area.setSelectionRange(0, text.length);
      return doc.execCommand("copy") === true;
    } finally {
      doc.body.removeChild(area);
    }
  } catch {
    return false;
  }
}
