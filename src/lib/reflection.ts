/**
 * セッション終了（「本日はここまで」）のオーケストレーション。
 *
 * 既存のCapture処理は置き換えない：ここで使うMemoryObjectは、
 * 会話中に既にcapture.tsが作成・更新済みのものをそのまま材料として使う。
 * 振り返り自体は、MEMORY_ENGINE.md 2.7「創造の結果を新しいMemory Objectとして保存する」
 * に対応する新しいtype:"insight"のMemoryObjectとして生成する（既存Memoryへの上書きではない）。
 */
"use client";

import { ulid } from "ulid";
import { loadApiKey } from "./db";
import { SCHEMA_VERSION } from "./types";
import type { Conversation, MemoryObject, Persona } from "./types";
import { GEMINI_API_KEY_HEADER } from "./apiKeyHeader";

const AI_PROVIDER = "gemini";

export async function generateSessionReflection(
  persona: Persona,
  sourceMemoryObject: MemoryObject
): Promise<string> {
  const apiKey = await loadApiKey();
  const res = await fetch("/api/reflect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { [GEMINI_API_KEY_HEADER]: apiKey } : {}),
    },
    body: JSON.stringify({
      persona,
      summary: sourceMemoryObject.summary,
      content: sourceMemoryObject.content,
      keywords: sourceMemoryObject.keywords,
    }),
  });
  if (!res.ok) {
    throw new Error(`reflect request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { reflection: string };
  return data.reflection;
}

export function createInsightMemoryObject(
  conversation: Conversation,
  sourceMemoryObject: MemoryObject,
  reflectionText: string
): MemoryObject {
  const timestamp = new Date().toISOString();
  return {
    id: ulid(),
    date: timestamp,
    types: ["insight"],
    conversationId: conversation.id,
    content: reflectionText,
    summary: reflectionText,
    // キーワードは元になった当日のMemoryObjectのものをそのまま引き継ぐ（再抽出はしない）。
    keywords: sourceMemoryObject.keywords,
    themeIds: [],
    personIds: [],
    emotionIds: [],
    goalIds: [],
    ideaIds: [],
    eventIds: [],
    links: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      id: ulid(),
      schemaVersion: SCHEMA_VERSION,
      source: "system-generated",
      aiProvider: AI_PROVIDER,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}
