/**
 * Markdown Importer（最初のImporter）。外部から持ち込まれたMarkdownテキストを
 * SourceDraftへ変換するだけの最小実装で、Importer/Coreの境界を検証するための実例。
 *
 * File System Access API・Vault操作・id/createdAt/updatedAtの生成には一切関与しない
 * （それぞれvault.ts・src/lib/source.tsのcreateSource()/persistSource()の責務）。
 * 呼び出し側が
 *   const draft = await importMarkdown(input);
 *   const source = createSource(draft);
 *   await persistSource(vaultHandle, source);
 * と自分で組み立てる。importMarkdown自身はcreateSource()/persistSource()を呼ばない。
 *
 * 既存Markdownのfrontmatter構造（markdown.tsのparseFrontmatter）をそのまま再利用し、
 * 新しいMarkdown仕様は発明しない。
 */
import { asString, parseFrontmatter } from "../markdown";
import type { Importer, SourceDraft } from "../types";

export interface MarkdownImportInput {
  markdown: string;
  fileName?: string;
}

/** frontmatterにtitleが無い場合のフォールバック。拡張子を除くだけの最小限の変換にとどめる。 */
function titleFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const withoutExtension = fileName.replace(/\.[^./\\]+$/, "");
  const base = withoutExtension.split(/[/\\]/).pop();
  return base && base.trim() ? base.trim() : undefined;
}

export const importMarkdown: Importer<MarkdownImportInput> = async (input) => {
  const parsed = parseFrontmatter(input.markdown);
  const frontmatterTitle = parsed ? asString(parsed.frontmatter.title) : undefined;
  const title = frontmatterTitle ?? titleFromFileName(input.fileName) ?? "Untitled";
  const content = (parsed ? parsed.body : input.markdown).trim();

  const draft: SourceDraft = {
    sourceType: "markdown",
    title,
    content,
    sourceDetail: input.fileName ? { fileName: input.fileName } : undefined,
  };
  return draft;
};
