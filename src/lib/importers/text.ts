/**
 * Text Importer。プレーンテキストをSourceDraftへ変換するだけの最小実装。
 * Markdown Importer・URL Importerと同じくImporter/Coreの境界を検証するための実例。
 *
 * File System Access API・Vault操作・IndexedDB・id/createdAt/updatedAtの生成には
 * 一切関与しない（それぞれvault.ts・src/lib/source.tsのcreateSource()/persistSource()の責務）。
 * 呼び出し側が
 *   const draft = await importText(input);
 *   const source = createSource(draft);
 *   await persistSource(vaultHandle, source);
 * と自分で組み立てる。importText自身はcreateSource()/persistSource()を呼ばない。
 */
import type { Importer, SourceDraft } from "../types";

export interface TextImportInput {
  text: string;
  title?: string;
  fileName?: string;
}

export const importText: Importer<TextImportInput> = async (input) => {
  const draft: SourceDraft = {
    sourceType: "text",
    title: input.title || "Untitled",
    content: input.text,
    sourceDetail: input.fileName ? { fileName: input.fileName } : undefined,
  };
  return draft;
};
