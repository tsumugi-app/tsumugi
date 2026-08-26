/**
 * Connect（MEMORY_ENGINE.md 2.3 / ROADMAP.md Phase 2）。
 *
 * 新しく生まれたMemoryを起点に、既存Retrieval Engineの候補絞り込みロジックを流用して
 * 過去の候補を探し、AIに「意味のあるつながりか」を判定させる。
 *
 *   New Memory → Retrieval → Candidate Memories → AI Connect → Link
 *
 * という非対称な処理であり、過去のMemoryを毎回全件再処理することはしない。
 *
 * Entity（Theme/Person等）は一切扱わない。MemoryObject同士を直接Linkでつなぐのみ
 * （DATA_MODEL.md §7「MemoryObject同士に限らず…も結べる汎用エッジ」）。
 */
"use client";

import { ulid } from "ulid";
import { getAllMemoryObjects, loadApiKey, putMemoryObject } from "./db";
import { writeMemoryObjectMarkdown } from "./vault";
import { retrieveRelevantMemories } from "./retrieval";
import { markMemoryConnected, releaseMemoryConnectClaim, tryClaimMemoryForConnect } from "./connectState";
import type { Link, LinkAxis, MemoryObject } from "./types";
import { GEMINI_API_KEY_HEADER } from "./apiKeyHeader";

const CANDIDATE_LIMIT = 5;
const MAX_LINKS_PER_MEMORY = 2;
const STRENGTH_THRESHOLD = 0.5;

interface ConnectJudgment {
  candidateId: string;
  axis: LinkAxis;
  reason: string;
  strength: number;
  contrast: boolean;
}

async function judgeCandidates(
  newMemory: MemoryObject,
  candidates: { id: string; date: string; summary: string; keywords: string[] }[]
): Promise<ConnectJudgment[]> {
  const apiKey = await loadApiKey();
  const res = await fetch("/api/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { [GEMINI_API_KEY_HEADER]: apiKey } : {}),
    },
    body: JSON.stringify({
      newMemory: {
        summary: newMemory.summary,
        content: newMemory.content,
        keywords: newMemory.keywords,
      },
      candidates,
    }),
  });
  if (!res.ok) {
    throw new Error(`connect request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { links: ConnectJudgment[] };
  return data.links ?? [];
}

/**
 * newMemoryを起点にConnectを1回実行する。
 *
 * 候補無し・材料不足等でLinkが結果的に0件でも「失敗」ではないため、
 * その場合も含めて成功時は必ずmarkMemoryConnectedを呼ぶ。
 * AI呼び出し自体が失敗（ネットワークエラー等）した場合のみ未処理のまま残し、
 * 次回のキャッチアップ（アプリ起動時）で再試行できるようにする。
 *
 * 冒頭でtryClaimMemoryForConnectによる排他制御を行う。React StrictModeの
 * useEffect二重実行や複数タブからの同時呼び出しでも、実際にAIを呼ぶのはクレームに
 * 成功した1回だけになる（connectStateへの完了記録は処理の最後にしか起きないため、
 * それだけでは開始時点の競合を防げない）。
 */
export async function connectMemory(
  vaultHandle: FileSystemDirectoryHandle | null,
  newMemory: MemoryObject
): Promise<void> {
  const claimed = await tryClaimMemoryForConnect(newMemory.id);
  if (!claimed) return;

  try {
    const queryText = `${newMemory.summary} ${newMemory.keywords.join(" ")}`.trim();
    if (!queryText) {
      await markMemoryConnected(newMemory.id);
      return;
    }

    const candidates = await retrieveRelevantMemories(queryText, {
      excludeConversationId: newMemory.conversationId,
      limit: CANDIDATE_LIMIT,
    });

    if (candidates.length === 0) {
      await markMemoryConnected(newMemory.id);
      return;
    }

    const judgments = await judgeCandidates(newMemory, candidates);

    const accepted = judgments
      .filter((judgment) => judgment.strength >= STRENGTH_THRESHOLD && judgment.reason?.trim())
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_LINKS_PER_MEMORY);

    if (accepted.length === 0) {
      await markMemoryConnected(newMemory.id);
      return;
    }

    const allMemories = await getAllMemoryObjects();
    const byId = new Map(allMemories.map((memory) => [memory.id, memory]));
    const now = new Date().toISOString();
    let updatedNewMemory = newMemory;

    for (const judgment of accepted) {
      const target = byId.get(judgment.candidateId);
      // 候補取得後に削除された等、既に存在しない場合はスキップする。
      if (!target) continue;

      const link: Link = {
        id: ulid(),
        sourceId: updatedNewMemory.id,
        targetId: target.id,
        axis: judgment.axis,
        reason: judgment.reason,
        contrast: judgment.contrast,
        strength: judgment.strength,
        createdBy: "ai-inference",
        createdAt: now,
      };

      updatedNewMemory = {
        ...updatedNewMemory,
        links: [...updatedNewMemory.links, link],
        updatedAt: now,
      };

      // 記憶単体からその接続関係を即座に読めるよう（DATA_MODEL.md §5）、
      // targetの側にも同じLinkを持たせ、どちらの記憶からも辿れるようにする。
      const updatedTarget: MemoryObject = {
        ...target,
        links: [...target.links, link],
        updatedAt: now,
      };
      if (vaultHandle) {
        await writeMemoryObjectMarkdown(vaultHandle, updatedTarget);
      }
      await putMemoryObject(updatedTarget);
    }

    if (vaultHandle) {
      await writeMemoryObjectMarkdown(vaultHandle, updatedNewMemory);
    }
    await putMemoryObject(updatedNewMemory);
    await markMemoryConnected(newMemory.id);
  } catch (error) {
    // 失敗時はクレームを解放し、次回のキャッチアップ等で再試行できるようにする。
    await releaseMemoryConnectClaim(newMemory.id);
    throw error;
  }
}
